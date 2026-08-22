import { and, desc, eq, gt, isNotNull, isNull, lt, lte, ne, or, sql } from "drizzle-orm";
import {
  alertState, billingEvents, billingReconciliationRuns, changeLog, devices, mailboxes,
  outboundSends, sessions, workerHeartbeats,
} from "./schema.js";
import { accountsWithSyncDisabled } from "./billing.js";
import { accountsAtStorageCap } from "./storage-cloud.js";
import type { Tx } from "./change-log.js";

/**
 * THE ALERTS. Seven rules, one evaluator, one delivery pass.
 *
 * ## The failure this file exists to prevent
 *
 * A Stripe webhook fails on every retry until Stripe gives up after ~3 days. The customer has
 * paid. The credits never landed. Every test is green. Nobody finds out. `billing_events`
 * carries a `status='failed'` row for that entire window — the evidence was always there and
 * nothing ever looked at it.
 *
 * The same shape covers the other three: an `outbound_sends` row that stays `pending` is a
 * mail the user believes they sent; a mailbox whose `last_sync_at` is an hour old is a
 * customer whose mail silently stopped arriving; and no leader heartbeat means the machine
 * that would fix all three is not running.
 *
 * ## Why it lives in `packages/db`
 *
 * Same reason as `credits.ts` and `ai-gate.ts`: the WORKER is one of the two
 * drivers, and the worker may import `@trafficflow/core` and `@trafficflow/db` and nothing
 * else — the worker's dependency test pins it, and a `packages/services` home would
 * typecheck, pass vitest through the alias, and then throw `MODULE_NOT_FOUND` in the Docker
 * image. Everything here is drizzle over the schema plus one `fetch`; nothing reaches for
 * `node:fs` or the migrator, so it belongs on the package ROOT rather than behind `/admin`.
 *
 * ## Evaluation is separate from delivery, deliberately
 *
 * {@link evaluateAlerts} is a pure read: it takes a clock and answers what is wrong right
 * now. That is what makes the admin console able to render exactly what the alerter would
 * page about, without the console being able to send anything — and what makes the whole
 * thing testable by seeding failure rows rather than by waiting three days for Stripe.
 *
 * {@link runAlertPass} adds the two things a pure evaluation cannot have: memory (so a
 * five-minute poll does not mail a human every five minutes for as long as the fault lasts)
 * and sinks.
 *
 * ## The alarm for "the alarm is broken" covers TWO states, not one
 *
 * `alerts_undeliverable` is the ERROR this file calls the single most dangerous thing it can
 * report. It originally fired on `sinks.length === 0` — nothing configured — and was therefore
 * silent in the strictly worse case: a sink that IS configured and refuses everything. That
 * state ran in production for months. Every pass logged `delivered=[] failedSinks=["webhook"]`
 * at WARN, which is indistinguishable from routine noise, and no page ever reached a human.
 *
 * So delivery failure is now counted ({@link DeliveryStreak}) and escalated to the same ERROR
 * after {@link DEFAULT_SINK_FAILURE_ESCALATION} consecutive failures, once per streak, cleared
 * by any success. And a refusal now has to SAY WHY — {@link AlertDeliveryResult} — because the
 * reason a sink refuses was, for the whole of that outage, information nobody had.
 *
 * ## Two drivers, because one of the rules is about the driver
 *
 * The worker runs the pass every minute. It cannot report its own death, so the API host
 * runs the SAME pass from `GET /internal/alerts`, driven by a scheduler that lives on
 * neither platform (a scheduled CI job). The worker being down, the worker's host being
 * down and the API's host being down are three different faults, and the pair covers all of them
 * except "everything is down", which the scheduler's own failure notification covers.
 */

/* ════════════════════════════════════════════════════════════════════════════════════════
   The rules, and the numbers the arch doc fixed
   ════════════════════════════════════════════════════════════════════════════════════════ */

/** The seven conditions. Stable strings — they are the alert identity in `alert_state`. */
export type AlertKind =
  /** No leader heartbeat for a shard within the threshold: nothing is syncing. */
  | "worker_down"
  /** `billing_events` rows sitting in `status='failed'`: money in, credits not granted. */
  | "billing_events_failed"
  /** `outbound_sends` still `pending` past the threshold: a send died mid-flight. */
  | "sends_stuck"
  /**
   * A mailbox THE ROSTER IS ON DUTY FOR whose newest sync is older than the threshold.
   * "On duty" is `status <> 'disabled'` AND an entitlement that says sync is on — the worker's
   * definition, not a second one; see rule 4 for what calling it "enabled" used to cost.
   */
  | "sync_lag"
  /**
   * An on-duty account whose counted stored-body bytes have reached its subscription's cap:
   * its mail keeps organizing on IMAP and NEW bodies are being withheld from the
   * hosted store. A scan rule and not an ingest-transition emission, deliberately — at-cap is
   * also ENTERED with no ingest event at all (a plan downgrade shrinks the cap; the 0062
   * backfill mints day-one at-cap accounts), and the two-driver design already survives the
   * worker being down.
   */
  | "storage_at_cap"
  /**
   * The latest billing-reconciliation pass found the mirror diverged from Stripe — events were
   * re-emitted (a webhook was lost: healed, but the loss itself is the news) or rows were
   * flagged unreconcilable. The named test rows (`test_row`) are excluded: production holds
   * one by design and paging about design is how a pager gets filtered.
   */
  | "billing_reconciliation_divergence"
  /**
   * No COMPLETED apply-mode reconciliation pass inside the threshold, on a deployment where
   * one has ever run. The reconciler exists to remove a silence; the rule exists so the
   * reconciler cannot itself go silent. Failed runs (error non-null) do not reset the clock.
   */
  | "billing_reconciliation_stale"
  /**
   * A paired NATIVE device (kind ≠ 'web') that used to reach the sync horizon has gone quiet
   * past the threshold while its account kept changing. Read from `devices.last_synced_at`
   * (mail 0064) — stamped only by a `GET /sync` answer with `hasMore: false`, so a mirror
   * stuck re-paging a backlog forever counts as quiet, exactly like one whose session died.
   * This is the alert a week of dead desktop sync did not have: the client retries on its own
   * backoff, its refresh family keeps rotating, and no other server-side signal moves.
   */
  | "device_sync_stale";

export type AlertSeverity = "critical" | "warning";

/**
 * The thresholds, verbatim from the pre-beta observability plan.
 *
 * They are one exported object rather than four constants because the admin console renders
 * them next to the numbers they judge ("stuck sends — pending past 10m"), and a UI that
 * invents its own threshold is a UI that disagrees with the pager.
 */
export interface AlertThresholds {
  /** No leader heartbeat for longer than this ⇒ the worker is down. Arch doc: 2 minutes. */
  leaderStaleMs: number;
  /** `outbound_sends.status='pending'` older than this is stuck. Arch doc: 10 minutes. */
  stuckSendMs: number;
  /** An on-duty mailbox not synced within this is lagging. Arch doc: 15 minutes. */
  syncLagMs: number;
  /**
   * No completed apply-mode reconciliation run within this ⇒ the reconciler is dark. Six
   * hours against an hourly cron: five missed runs before a page, so one platform hiccup is
   * not a 3am mail, while a genuinely dead cron pages the same day it died.
   */
  reconcileStaleMs: number;
  /**
   * A native device whose last horizon-reaching `/sync` is older than this, while its account
   * has newer changes, is a dead mirror. Three days: a laptop closed over a weekend is not a
   * page, a desktop that died on a Monday pages before the week is out — measured against the
   * incident this exists for, which ran silent for seven.
   */
  deviceSyncStaleMs: number;
}

export const DEFAULT_ALERT_THRESHOLDS: AlertThresholds = {
  leaderStaleMs: 2 * 60 * 1000,
  stuckSendMs: 10 * 60 * 1000,
  syncLagMs: 15 * 60 * 1000,
  reconcileStaleMs: 6 * 60 * 60 * 1000,
  deviceSyncStaleMs: 3 * 24 * 60 * 60 * 1000,
};

/**
 * How long a firing alert waits before it pages again.
 *
 * Not zero (that is the alert address people learn to filter) and not infinite (a fault
 * nobody fixed must resurface). One hour: long enough that a night of a broken worker is six
 * mails and not three hundred, short enough that an alert seen and forgotten comes back
 * before the customer notices.
 */
export const DEFAULT_ALERT_REPEAT_MS = 60 * 60 * 1000;

/**
 * One firing condition.
 *
 * `key` is the identity in `alert_state`; `count`/`oldestSeconds` are the two numbers every
 * rule can produce, and `detail` is the sentence a human reads at 3am. Nothing here can carry
 * mail content: every field is derived from a count, an age, or a rule name.
 */
export interface Alert {
  key: string;
  kind: AlertKind;
  severity: AlertSeverity;
  /** One line, imperative enough to act on. */
  title: string;
  /** The numbers behind the title. */
  detail: string;
  /** Affected rows (mailboxes, events, sends). `1` for a singleton condition. */
  count: number;
  /** Age of the oldest affected row, or of the staleness itself. */
  oldestSeconds: number | null;
}

/* ════════════════════════════════════════════════════════════════════════════════════════
   Evaluation — a pure read, four queries
   ════════════════════════════════════════════════════════════════════════════════════════ */

export interface EvaluateOptions {
  now?: Date;
  thresholds?: Partial<AlertThresholds>;
  /**
   * Shards that MUST have a live leader. Defaults to `[0]` — the shipped configuration is
   * one shard (`leaderLockKeyFor(0)`), and a missing heartbeat row for shard 0 with no
   * expectation would make "the worker has never started" indistinguishable from "there is
   * no shard 0", which is the exact failure this rule exists to catch.
   */
  shards?: readonly number[];
}

function secondsBetween(now: Date, then: Date | null): number | null {
  if (!then) return null;
  return Math.max(0, Math.round((now.getTime() - then.getTime()) / 1000));
}

/** `4h 12m` / `3m` / `48s` — an age a human parses without arithmetic. */
export function humanAge(seconds: number | null): string {
  if (seconds === null) return "never";
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  if (h < 24) return rem > 0 ? `${h}h ${rem}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

/**
 * Answer "what is wrong right now", in four queries and with no side effects.
 *
 * READ-ONLY on purpose. The admin console calls exactly this to render the alert list, so
 * the surface an operator looks at and the condition that pages them cannot drift apart —
 * and a console that could write would be a console that could silence a pager.
 */
export async function evaluateAlerts(db: Tx, opts: EvaluateOptions = {}): Promise<Alert[]> {
  const now = opts.now ?? new Date();
  const t: AlertThresholds = { ...DEFAULT_ALERT_THRESHOLDS, ...opts.thresholds };
  const shards = opts.shards ?? [0];
  const alerts: Alert[] = [];

  // ── 1. no leader heartbeat > threshold ────────────────────────────────────────────────
  //
  // Reads the heartbeat ROW, not `pg_locks`: an advisory lock is session-scoped, so a dead
  // worker's lock does not exist and `pg_locks` can only say "not held right now" — which
  // makes the detection latency equal to the poll interval and the "2 minutes" meaningless.
  // See the migration header.
  const beats = await db
    .select({
      shardIndex: workerHeartbeats.shardIndex,
      instanceId: workerHeartbeats.instanceId,
      beatAt: workerHeartbeats.beatAt,
      leader: workerHeartbeats.leader,
    })
    .from(workerHeartbeats);
  const bySh = new Map(beats.map((b) => [Number(b.shardIndex), b]));
  for (const shard of shards) {
    const beat = bySh.get(shard);
    const staleSeconds = beat ? secondsBetween(now, beat.beatAt) : null;
    const stale = !beat || !beat.leader || (staleSeconds ?? Infinity) * 1000 > t.leaderStaleMs;
    if (!stale) continue;
    alerts.push({
      key: `worker_down:${shard}`,
      kind: "worker_down",
      severity: "critical",
      title: `Sync worker (shard ${shard}) is not running`,
      detail: beat
        ? `Last leader heartbeat from ${beat.instanceId} was ${humanAge(staleSeconds)} ago ` +
          `(threshold ${humanAge(Math.round(t.leaderStaleMs / 1000))}). No mailbox is syncing.`
        : `No leader has ever written a heartbeat for shard ${shard}. No mailbox is syncing.`,
      count: 1,
      oldestSeconds: staleSeconds,
    });
  }

  // ── 2. billing_events stuck in 'failed' ───────────────────────────────────────────────
  //
  // THE one from the Stripe review. A `failed` row is claimable — the next retry will try
  // again — but Stripe stops retrying after ~3 days, and after that the row is a permanent
  // record of money taken for credits that were never granted. There is no threshold: one
  // failed row is already the alert.
  const failedEvents = await db
    .select({
      count: sql<number>`count(*)::int`,
      oldest: sql<Date | null>`min(${billingEvents.receivedAt})`,
    })
    .from(billingEvents)
    .where(eq(billingEvents.status, "failed"));
  const failedCount = Number(failedEvents[0]?.count ?? 0);
  if (failedCount > 0) {
    const oldest = failedEvents[0]?.oldest ? new Date(failedEvents[0].oldest as unknown as string) : null;
    const oldestSeconds = secondsBetween(now, oldest);
    alerts.push({
      key: "billing_events_failed",
      kind: "billing_events_failed",
      severity: "critical",
      title: `${failedCount} Stripe webhook event${failedCount === 1 ? "" : "s"} failed to apply`,
      detail:
        `${failedCount} row(s) in billing_events are status='failed'; the oldest arrived ` +
        `${humanAge(oldestSeconds)} ago. A paid invoice whose apply failed grants no credits, ` +
        `and Stripe stops retrying after ~3 days. Inspect the queue in the admin console.`,
      count: failedCount,
      oldestSeconds,
    });
  }

  // ── 3. outbound_sends pending > threshold ─────────────────────────────────────────────
  //
  // `pending` is a RESERVATION, not a delivery: the row is written before SMTP is touched, so
  // one older than the threshold means the process that reserved it died mid-flight. Never
  // auto-resent (the resolver checks Sent first) — which is precisely why a human has to be
  // told the queue is not draining.
  const stuckBefore = new Date(now.getTime() - t.stuckSendMs);
  const stuck = await db
    .select({
      count: sql<number>`count(*)::int`,
      oldest: sql<Date | null>`min(${outboundSends.createdAt})`,
    })
    .from(outboundSends)
    .where(and(eq(outboundSends.status, "pending"), lt(outboundSends.createdAt, stuckBefore)));
  const stuckCount = Number(stuck[0]?.count ?? 0);
  if (stuckCount > 0) {
    const oldest = stuck[0]?.oldest ? new Date(stuck[0].oldest as unknown as string) : null;
    const oldestSeconds = secondsBetween(now, oldest);
    alerts.push({
      key: "sends_stuck",
      kind: "sends_stuck",
      severity: "critical",
      title: `${stuckCount} send${stuckCount === 1 ? " is" : "s are"} stuck pending`,
      detail:
        `${stuckCount} outbound_sends row(s) have been 'pending' longer than ` +
        `${humanAge(Math.round(t.stuckSendMs / 1000))}; the oldest is ${humanAge(oldestSeconds)} old. ` +
        `The user believes these were sent. They are never auto-resent.`,
      count: stuckCount,
      oldestSeconds,
    });
  }

  // ── 4. sync lag > threshold on any mailbox THE WORKER IS ACTUALLY ON DUTY FOR ─────────
  //
  // ── THE POPULATION MISMATCH THIS FIXES (independent review of the 0021 slice, #10) ──
  //
  // This rule used to call every `status <> 'disabled'` row enabled, on the stated grounds
  // that it was "the SAME predicate the worker's roster uses". It was half of it.
  // `loadEnabledMailboxes` applies that predicate AND THEN drops every account whose
  // entitlement says `syncEnabled: false` (`accountsWithSyncDisabled`). So a paused or unpaid
  // subscription leaves `connected` rows the roster deliberately PARKS: nothing syncs them, by
  // design, their stamps age past fifteen minutes within the hour, and this rule then paged a
  // human forever about a billing state working exactly as intended — which is the noisy-alert
  // failure the whole file exists to avoid, in the one rule an operator most needs to trust.
  //
  // The duty set is now read from ONE function, `accountsWithSyncDisabled` in `billing.ts`, so
  // "which mailboxes are supposed to be syncing" has a single definition that the roster and
  // the pager cannot answer differently. (The worker still holds its own copy of that query;
  // see the function's header.)
  //
  // Everything else about the rule is unchanged and still deliberate. A DISABLED mailbox (the
  // billing-downgrade path) is out of scope. A QUARANTINED one (`status='error'`) is in the
  // roster and is therefore in scope: its owner is not receiving mail, which is the point.
  // `last_sync_at IS NULL` is not an alert on its own — a mailbox enrolled thirty seconds ago
  // has never synced and is not a fault — so it falls back to `created_at` and a never-synced
  // mailbox counts only once it is older than the threshold.
  //
  // GROUPED BY ACCOUNT rather than counted flat, because the entitlement decision is
  // per-account: the group-by is what lets the parked accounts be subtracted before the count
  // is formed. The result set is one row per account with a lagging mailbox — bounded by the
  // account count even when a dead worker makes every mailbox lag.
  const lagBefore = new Date(now.getTime() - t.syncLagMs);
  const laggingByAccount = await db
    .select({
      accountId: mailboxes.accountId,
      count: sql<number>`count(*)::int`,
      oldest: sql<Date | null>`min(coalesce(${mailboxes.lastSyncAt}, ${mailboxes.createdAt}))`,
    })
    .from(mailboxes)
    .where(and(
      ne(mailboxes.status, "disabled"),
      // AN ISO STRING WITH AN EXPLICIT CAST, NOT A `Date` — the rule `mail-service.ts`
      // states at length, and this is the second place it has bitten. The left side is a
      // raw `coalesce(...)` fragment, so drizzle cannot infer a column type for the
      // comparison and postgres-js binds the parameter against the type Postgres describes
      // for `$n`, which is TEXT; handed a `Date` it throws `ERR_INVALID_ARG_TYPE`. PGlite
      // binds a `Date` happily, so the unit suite was green while every production pass
      // died — which the worker e2e caught only because the pass now LOGS its own
      // failure instead of swallowing it.
      sql`coalesce(${mailboxes.lastSyncAt}, ${mailboxes.createdAt}) < ${lagBefore.toISOString()}::timestamptz`,
    ))
    .groupBy(mailboxes.accountId);

  const parked = await accountsWithSyncDisabled(db, laggingByAccount.map((r) => r.accountId), now);
  const onDuty = laggingByAccount.filter((r) => !parked.has(r.accountId));
  const lagCount = onDuty.reduce((n, r) => n + Number(r.count), 0);
  const parkedCount = laggingByAccount
    .filter((r) => parked.has(r.accountId))
    .reduce((n, r) => n + Number(r.count), 0);

  if (lagCount > 0) {
    const oldest = onDuty
      .map((r) => (r.oldest ? new Date(r.oldest as unknown as string) : null))
      .reduce<Date | null>((min, d) => (d && (!min || d < min) ? d : min), null);
    const oldestSeconds = secondsBetween(now, oldest);
    alerts.push({
      key: "sync_lag",
      kind: "sync_lag",
      // WARNING, not critical: a worker restart or one throttling provider produces this for
      // a few minutes and resolves itself. It becomes critical by co-occurring with
      // `worker_down`, which is the alert a human should read first.
      severity: "warning",
      title: `${lagCount} mailbox${lagCount === 1 ? "" : "es"} behind by more than ` +
        `${humanAge(Math.round(t.syncLagMs / 1000))}`,
      detail:
        `${lagCount} mailbox(es) the worker is on duty for have not synced within ` +
        `${humanAge(Math.round(t.syncLagMs / 1000))}; the worst is ${humanAge(oldestSeconds)} behind. ` +
        `Their owners are not receiving mail.` +
        // The exclusion is STATED, not silent. An operator who knows five mailboxes are stale
        // and reads "3" must be able to see where the other two went without reading this file.
        (parkedCount > 0
          ? ` (${parkedCount} further stale mailbox(es) are parked by their subscription's ` +
            `entitlement and are deliberately not synced — not counted.)`
          : ""),
      count: lagCount,
      oldestSeconds,
    });
  }

  // ── 5. accounts at their storage cap ───────────────────────────────────────────────────
  //
  // The population is `accountsAtStorageCap` — counted stored-body bytes ≥ the EFFECTIVE
  // subscription row's cap, resolved with the same live-preferred ordering as every other
  // entitlement read. Accounts the roster has PARKED are subtracted on rule 4's own argument:
  // a parked account ingests nothing, so nothing is being withheld from it, and paging about
  // it would be the noisy-alert failure again. One grouped alert, not one per account —
  // bounded, content-free (a count and two byte figures), and the operator's remedy is the
  // same whoever is in it.
  //
  // WARNING, not critical: the product is behaving as specified — mail still arrives, still
  // organizes on IMAP, the user has been told in Settings and on the message — but a human
  // should know who is bumping the ceiling before the support mail arrives.
  const atCap = await accountsAtStorageCap(db);
  const capParked = await accountsWithSyncDisabled(db, atCap.map((r) => r.accountId), now);
  const atCapOnDuty = atCap.filter((r) => !capParked.has(r.accountId));
  if (atCapOnDuty.length > 0) {
    const worst = atCapOnDuty.reduce((m, r) => (r.bytes - r.storageBytesLimit > m.bytes - m.storageBytesLimit ? r : m));
    alerts.push({
      key: "storage_at_cap",
      kind: "storage_at_cap",
      severity: "warning",
      title: `${atCapOnDuty.length} account${atCapOnDuty.length === 1 ? " is" : "s are"} at the storage cap`,
      detail:
        `${atCapOnDuty.length} on-duty account(s) hold stored mail bodies at or over their plan's ` +
        `storage cap. The rolling window should be trimming these before they reach the cap ` +
        `(worker storage_evict_pass), so an account HERE means the trim is lagging or broken — ` +
        `ingest is evicting inline per message meanwhile, and IMAP is untouched. The largest overshoot is ` +
        `${worst.bytes - worst.storageBytesLimit} bytes over a ${worst.storageBytesLimit}-byte cap.` +
        (capParked.size > 0
          ? ` (${capParked.size} further at-cap account(s) are parked by their subscription's ` +
            `entitlement and ingest nothing — not counted.)`
          : ""),
      count: atCapOnDuty.length,
      oldestSeconds: null,
    });
  }

  // ── 6. the billing mirror diverged from Stripe (reconciliation) ────────────────────────
  //
  // Reads the NEWEST completed `billing_reconciliation_runs` row, either mode: a dry run that
  // saw divergence is the same fact about the mirror as an armed run that healed it. Two
  // things matter to a human:
  //  · `emitted > 0` — webhooks were LOST. The heal already ran (or is queued, on a dry run),
  //    so the page is about the pipeline, not the data: something dropped a delivery, and the
  //    next drop might be an invoice. WARNING while everything applied cleanly.
  //  · flags (minus `test_row`) or failed applies — divergence the pass could NOT close:
  //    an unattributable live subscription, a mirror row Stripe does not hold, an apply that
  //    failed. CRITICAL: money state needs a person.
  // The alert RESOLVES through the same read: the next converged pass writes emitted=0 with no
  // flags, this rule stops firing, and `runAlertPass` closes the alert_state row.
  const lastRun = await db
    .select({
      ranAt: billingReconciliationRuns.ranAt,
      mode: billingReconciliationRuns.mode,
      emitted: billingReconciliationRuns.emitted,
      applyFailed: billingReconciliationRuns.applyFailed,
      flagged: billingReconciliationRuns.flagged,
      truncated: billingReconciliationRuns.truncated,
    })
    .from(billingReconciliationRuns)
    .where(sql`${billingReconciliationRuns.error} is null`)
    .orderBy(sql`${billingReconciliationRuns.ranAt} desc`)
    .limit(1);
  const run = lastRun[0];
  // THE DURABLE HALF OF THE EVIDENCE: a heal that LANDED is a
  // `billing_events` claim of the reconciliation's own type, and it survives a pass that died
  // between applying and recording its run row — the exact sequence in which the run ledger
  // alone would report a converged mirror and never page the lost webhook. Recent claims are
  // therefore an independent trigger, windowed at 24 h so the operator has a day to see it and
  // it self-resolves after.
  const healWindow = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const recentHeals = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(billingEvents)
    // APPLIED only: a failed reconciliation apply writes the same type with status='failed',
    // and it is already the failed-events rule's critical page — counting it here as a heal
    // would say "applied" and "failed" about one row in two alerts.
    .where(sql`${billingEvents.type} = 'reconciliation.subscription'
      and ${billingEvents.status} = 'applied'
      and ${billingEvents.receivedAt} > ${healWindow.toISOString()}::timestamptz`);
  const healCount = Number(recentHeals[0]?.n ?? 0);
  if (run || healCount > 0) {
    const flagged = (run?.flagged ?? {}) as Record<string, number>;
    // `test_row` (a standing test account) and `comp_row` (operator comps) are DESIGN, present on
    // every pass by construction — excluded here so the pager never learns to be filtered.
    // They stay visible in every run row and every dry-run read.
    const flaggedReal = Object.entries(flagged)
      .filter(([code]) => code !== "test_row" && code !== "comp_row");
    const flaggedCount = flaggedReal.reduce((n, [, c]) => n + Number(c), 0);
    const unhealed = flaggedCount + (run?.applyFailed ?? 0);
    const emitted = run?.emitted ?? 0;
    // `truncated` fires too: a bound that stops every pass at
    // the same prefix leaves the tail permanently unread, and a clean prefix must not read as
    // a clean population.
    if (emitted > 0 || unhealed > 0 || healCount > 0 || run?.truncated === true) {
      const ranSeconds = run ? secondsBetween(now, run.ranAt) : null;
      const found = Math.max(emitted + flaggedCount, healCount);
      alerts.push({
        key: "billing_reconciliation_divergence",
        kind: "billing_reconciliation_divergence",
        severity: unhealed > 0 ? "critical" : "warning",
        // A truncation-only firing must not present itself as "0 divergences" — the incident
        // is the UNREAD population, and the title says so.
        title: found > 0
          ? `Billing reconciliation: ${found} divergence(s) between Stripe and the mirror`
          : "Billing reconciliation was truncated — part of the population went unread",
        detail:
          (run
            ? `The latest reconciliation pass (${run.mode}, ${humanAge(ranSeconds)} ago) ` +
              `${run.mode === "apply" ? "re-emitted" : "would re-emit"} ${emitted} subscription ` +
              `event(s) the webhook pipeline lost` +
              ((run.applyFailed ?? 0) > 0 ? `, of which ${run.applyFailed} FAILED to apply (see billing_events)` : "") +
              (flaggedCount > 0
                ? `, and flagged ${flaggedCount} row(s) it cannot reconcile: ` +
                  flaggedReal.map(([code, c]) => `${code}×${c}`).join(", ")
                : "") + "."
            : "No completed reconciliation run is recorded, yet reconciliation events applied — " +
              "a pass died between healing and recording.") +
          (healCount > 0 ? ` ${healCount} reconciliation event(s) applied in the last 24 h.` : "") +
          (run?.truncated === true
            ? " The pass was TRUNCATED at its bound — part of the population went UNREAD and" +
              " absence checks were skipped; raise the bound or shrink the population."
            : "") +
          " A lost webhook heals here, but the loss is the incident: check the relay and the plane.",
        count: Math.max(found, 1),
        oldestSeconds: ranSeconds,
      });
    }
  }

  // ── 7. the reconciler itself went dark ─────────────────────────────────────────────────
  //
  // Fires only on a deployment where an APPLY-mode pass has ever completed (a self-hosted
  // deployment that never armed the cron stays silent — same contract as `worker_down`, which
  // needs `shards` to say what to expect). Failed runs are excluded on purpose: a reconciler
  // that fails every pass is exactly as dark as one that stopped, and a failure row that reset
  // the clock would page NEVER, which is the quiet branch this whole slice exists to remove.
  const lastApply = await db
    .select({ ranAt: billingReconciliationRuns.ranAt })
    .from(billingReconciliationRuns)
    .where(sql`${billingReconciliationRuns.mode} = 'apply' and ${billingReconciliationRuns.error} is null`)
    .orderBy(sql`${billingReconciliationRuns.ranAt} desc`)
    .limit(1);
  const anyApply = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(billingReconciliationRuns)
    .where(sql`${billingReconciliationRuns.mode} = 'apply'`);
  const applyEver = Number(anyApply[0]?.n ?? 0) > 0;
  if (applyEver) {
    const freshest = lastApply[0]?.ranAt ?? null;
    const staleSeconds = freshest ? secondsBetween(now, freshest) : null;
    const dark = staleSeconds === null || staleSeconds * 1000 > t.reconcileStaleMs;
    if (dark) {
      alerts.push({
        key: "billing_reconciliation_stale",
        kind: "billing_reconciliation_stale",
        severity: "warning",
        title: "The billing reconciliation has stopped running",
        detail:
          (staleSeconds === null
            ? "Apply-mode reconciliation runs exist but none ever completed. "
            : `The last completed apply-mode reconciliation pass was ${humanAge(staleSeconds)} ago ` +
              `(threshold ${humanAge(Math.round(t.reconcileStaleMs / 1000))}). `) +
          "A lost Stripe webhook now stays unhealed until this is fixed — check the " +
          "/internal/billing/reconcile cron and the billing plane.",
        count: 1,
        oldestSeconds: staleSeconds,
      });
    }
  }

  // ── 8. a paired native device that stopped syncing ──────────────────────────────────────
  //
  // The population is `devices.last_synced_at` (mail 0064): stamped only by a `GET /sync`
  // answer that reached the horizon, so "quiet" covers both ways the incident this guards
  // actually happened — a mirror stuck re-paging its backlog forever (requests happening, no
  // convergence) and a session killed by refresh-reuse detection (no requests at all). The
  // client cannot report either: it retries on its own backoff and shows what it holds.
  //
  // Three gates, each a correctness statement:
  //  · kind ≠ 'web' — a browser tab left closed is not an incident; the desktop IS one;
  //  · the account MOVED ON — the newest change_log row is younger than the device's last
  //    horizon, so there demonstrably was mail the device never received. A dormant account
  //    keeps its devices quiet and unpaged;
  //  · the device is still ARMED — an unrevoked session (alive but not converging), or one
  //    revoked within 14 days (reuse detection writes no audit row and tells nobody, so the
  //    person is likely still in front of a mirror that silently died). A device retired
  //    months ago ages out of the arm window and the alert closes on its own.
  //
  // Per-device keys, like `worker_down:<shard>`: paired native devices are tens fleet-wide,
  // the remedy is per-device, and a grouped count would hide WHICH mirror is dead.
  const deviceStaleCut = new Date(now.getTime() - t.deviceSyncStaleMs);
  const staleDevices = await db.select().from(devices)
    .where(and(
      ne(devices.kind, "web"),
      isNotNull(devices.lastSyncedAt),
      lt(devices.lastSyncedAt, deviceStaleCut),
    ));
  const deviceArmWindowMs = 14 * 24 * 60 * 60 * 1000;
  for (const d of staleDevices) {
    if (d.lastSyncedAt == null) continue; // isNotNull above; narrows the type
    // Index-backed: (account_id, seq) descending, first row — the newest change's wall clock.
    const [latest] = await db.select({ createdAt: changeLog.createdAt }).from(changeLog)
      .where(eq(changeLog.accountId, d.accountId))
      .orderBy(desc(changeLog.seq)).limit(1);
    if (!latest || latest.createdAt <= d.lastSyncedAt) continue;
    const armCut = new Date(now.getTime() - deviceArmWindowMs);
    const armed = await db.select({ id: sessions.id }).from(sessions)
      .where(and(
        eq(sessions.deviceId, d.id),
        or(isNull(sessions.revokedAt), gt(sessions.revokedAt, armCut)),
      ))
      .limit(1);
    if (armed.length === 0) continue;
    const staleSeconds = secondsBetween(now, d.lastSyncedAt);
    alerts.push({
      key: `device_sync_stale:${d.id}`,
      kind: "device_sync_stale",
      // WARNING, not critical: mail is safe on the account and the webapp still shows it —
      // what is broken is one device's mirror, and the person may not know.
      severity: "warning",
      title: `A paired ${d.kind} device has not synced in ${humanAge(staleSeconds)}`,
      detail:
        `Device ${d.id} (kind ${d.kind}) last reached the sync horizon ` +
        `${humanAge(staleSeconds)} ago (threshold ${humanAge(Math.round(t.deviceSyncStaleMs / 1000))}), ` +
        `and its account has newer changes it never received. Its session is still armed ` +
        `(live, or revoked within 14 days) — the person in front of it is reading stale ` +
        `mail and the client cannot say so.`,
      count: 1,
      oldestSeconds: staleSeconds,
    });
  }

  return alerts;
}

/* ════════════════════════════════════════════════════════════════════════════════════════
   Delivery
   ════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * What one sink has to say about one delivery attempt.
 *
 * `ok` alone was the whole contract until a configured webhook refused **every** delivery for
 * months and the logs could only ever say `failedSinks:["webhook"]` — true, useless, and
 * indistinguishable between a dead URL, a 429, a DNS failure and a value with quotes baked
 * into it. `error` is the missing half: a short diagnostic the sink is responsible for making
 * safe to log.
 *
 * **Whatever a sink puts in `error` is written to the log**, so a sink whose endpoint is a
 * bearer credential (an ntfy topic, a Slack or Discord hook path) must redact it first —
 * {@link webhookAlertSink} does, and its helper is the reference.
 */
export interface AlertDeliveryResult {
  ok: boolean;
  /** Why it failed, already redacted and bounded. Ignored when `ok`. */
  error?: string | null;
  /**
   * The CLOSED code for what happened, beside the free-text {@link error}.
   *
   * The prose stays — it was added because "the webhook refused" with no reason attached was
   * the state this file spent months in, and that ruling is not being undone. But prose is the
   * wrong thing for a machine: it is vendor-authored, unbounded, and it lands on `/health`,
   * which is a surface anybody can read. So every failure now carries BOTH — a token a guard
   * can assert on and a health endpoint can publish, and a sentence a human can diagnose from.
   *
   * Optional, and derived when a sink omits it (`ok ? "ok" : "refused"`), so every existing
   * sink and every test fake stays valid.
   */
  outcome?: AlertSinkOutcome;
}

/**
 * What happened to ONE delivery through ONE sink. A closed set, because it is published on
 * `/health` and asserted on by guards.
 *
 *  · `ok` — the vendor accepted it.
 *  · `misconfigured` — the sink was built from values it cannot use, and refuses every
 *    delivery saying which value. Set-but-unusable, which is NOT the same state as unset.
 *  · `refused` — the vendor answered, with a non-2xx. Its network path is fine; it said no.
 *  · `unreachable` — the request never got an answer: DNS, TCP, TLS. **This is the shape of
 *    the ntfy.sh outage** — a sink whose host blackholes this deployment's egress — and it is
 *    worth its own token precisely because it looks identical to `refused` in prose.
 *  · `timeout` — the request was still open when the sink's own deadline expired.
 *  · `threw` — the sink violated its never-throws contract and `deliver` caught it.
 */
export type AlertSinkOutcome =
  | "ok"
  | "misconfigured"
  | "refused"
  | "unreachable"
  | "timeout"
  | "threw";

/**
 * Classify a value that came out of a sink's `catch` into a closed {@link AlertSinkOutcome}.
 *
 * Shared by every sink so that "the host blackholes us" reads as the same token whichever arm
 * hit it — the whole point of a closed code is that two sinks cannot spell one condition two
 * ways. An abort is the sink's own deadline (`nodePostJson` aborts at 8 s); everything else
 * that never reached an HTTP status is `unreachable`, which is the honest verdict for a
 * transport that produced no answer.
 */
export function classifyTransportError(err: unknown): AlertSinkOutcome {
  const e = err as { name?: unknown };
  // `AbortError` is what an `AbortController` deadline produces; `TimeoutError` is what
  // `AbortSignal.timeout` produces. Neither is a refusal — nobody said no.
  const name = typeof e?.name === "string" ? e.name : "";
  if (name === "AbortError" || name === "TimeoutError") return "timeout";
  return "unreachable";
}

/**
 * Where an alert goes. ONE method, and it never throws.
 *
 * Same contract as `MailerPort.send` and for the same reason: a sink that throws would abort
 * the pass, and the second sink — the one that might actually have reached a human — would
 * never run. A sink reports its own failure by resolving `false`, or by resolving an
 * {@link AlertDeliveryResult} that also says why.
 *
 * The bare `boolean` is still valid and is not deprecated: `mailAlertSink` has nothing to add
 * beyond "the mailer refused", and a sink that would only be able to stringify an exception it
 * has not vetted for secrets is better off saying nothing.
 */
export interface AlertSink {
  readonly name: string;
  notify(alerts: readonly Alert[], ctx: AlertNotifyContext): Promise<boolean | AlertDeliveryResult>;
}

export interface AlertNotifyContext {
  /** `worker` / `api` — which driver observed this. */
  source: string;
  environment: string;
  now: Date;
}

/**
 * One JSON POST. `body` is the response text and is OPTIONAL — a fake that returns only a
 * status is still a valid `PostJson`, which is what keeps every existing test fake compiling.
 *
 * `headers` was added for `resendAlertSink` (`alert-mail.ts`), whose credential travels in an
 * `Authorization` header rather than in the URL path. Optional and LAST, so every existing
 * two-parameter fake remains assignable — a function taking fewer parameters satisfies a type
 * taking more, which is the property the widening leans on.
 */
export type PostJson = (
  url: string, body: string, headers?: Record<string, string>,
) => Promise<{ status: number; body?: string }>;

/**
 * Production `PostJson` over `fetch`, with a hard timeout. Injected so tests never open a socket.
 *
 * The RESPONSE TEXT is read on a refusal and only on a refusal. Every service this sink can
 * point at explains itself in that body — ntfy answers `{"code":42204,...}`, Slack answers
 * `invalid_token`, Discord answers a JSON error — and without it a rejection is a bare number
 * whose cause takes a deploy to learn. It is capped here rather than at the caller so a sink
 * pointed at something that answers megabytes cannot turn an alert into a memory event; the
 * read shares the same abort signal, so a server that stalls mid-body still times out.
 */
export const nodePostJson: PostJson = async (url, body, headers) => {
  const ac = new AbortController();
  const timer = setTimeout(() => { ac.abort(); }, 8000);
  try {
    // The JSON media type is this seam's CONTRACT (`PostJson` — one JSON POST), so a caller
    // cannot move it: caller headers first, the fixed content-type last, and any caller copy
    // stripped case-insensitively — header names are case-insensitive at the wire, so a
    // `Content-Type` beside our `content-type` would have combined into an invalid
    // `application/json, text/plain` rather than overriding cleanly.
    const merged: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers ?? {})) {
      if (k.toLowerCase() === "content-type") continue;
      merged[k] = v;
    }
    merged["content-type"] = "application/json";
    const res = await fetch(url, {
      method: "POST",
      headers: merged,
      body,
      signal: ac.signal,
    });
    if (res.status >= 200 && res.status < 300) return { status: res.status };
    let text: string | undefined;
    try { text = (await res.text()).slice(0, 300); } catch { /* a body we cannot read is not the story */ }
    return { status: res.status, body: text };
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Make a failure sentence safe to log.
 *
 * THE ENDPOINT IS A CREDENTIAL for most of what this sink targets: an ntfy topic, a Slack
 * incoming-hook path and a Discord webhook token are all bearer secrets carried in the URL
 * PATH. `fetch` failures and error bodies quote the request, so the raw text cannot go to a
 * log drain. The HOST is kept — `ENOTFOUND ntfy.sh` and `ECONNREFUSED` are the diagnosis and
 * the host is not the secret — and the path is not.
 *
 * Bounded to 200 characters because this lands in every `alert_notified` line, and an
 * observability field that can be arbitrarily long is a log bill, not a diagnostic.
 */
export function redactEndpoint(raw: string, endpoint: string): string {
  let out = raw.replace(/\s+/g, " ").trim();
  let origin = "";
  let path = "";
  try { const u = new URL(endpoint); origin = u.origin; path = u.pathname; } catch { /* see below */ }
  // Longest match first: the whole URL collapses to its ORIGIN plus a masked path, so a reader
  // still learns which service refused. An endpoint that would not even parse has no origin to
  // keep and is masked whole — that value is itself the fault, and `webhookAlertSink` names it.
  if (endpoint) out = out.split(endpoint).join(origin ? `${origin}/<redacted>` : "<endpoint>");
  if (path.length >= 4) out = out.split(path).join("/<redacted>");
  return out.length > 200 ? `${out.slice(0, 200)}…` : out;
}

/**
 * The GENERIC webhook sink — one JSON POST, no vendor SDK, no new paid service.
 *
 * This is the sink the WORKER uses, and it is why the worker can page a human at all: it
 * needs no `packages/services` import and no dependency beyond `fetch`. The payload
 * carries both a `text` field and a structured `alerts` array, which is enough for ntfy.sh
 * (free, delivers a phone push), a Slack or Discord incoming webhook, or a PagerDuty Events
 * v2 endpoint — the operator picks one and sets `TF_ALERT_WEBHOOK_URL`.
 *
 * Unset ⇒ {@link webhookAlertSink} returns null and the pass simply has one fewer sink.
 * A deployment with NO sink at all is reported by {@link runAlertPass} in its result, so
 * "we configured nothing" is visible rather than silent.
 *
 * ── SET-BUT-UNUSABLE IS NOT THE SAME STATE AS UNSET, AND IT USED TO LOOK LIKE IT ─────────
 *
 * A value that is present but not an http(s) URL — the classic being an env file whose value
 * kept its surrounding quotes, so the variable holds `"https://…"` including the quote
 * characters — made `fetch` throw, and the `catch` below turned that into a bare `false`
 * forever. Returning `null` for it would be worse still: the pass would then report
 * `undeliverable` and the operator would be told to set a variable that IS set.
 *
 * So it is parsed ONCE, here, and a bad value produces a sink that refuses every delivery with
 * that as its stated reason. The fault is then named by the escalation instead of being a
 * silent hole with a plausible-looking configuration behind it.
 */
export function webhookAlertSink(url: string | undefined, post: PostJson = nodePostJson): AlertSink | null {
  if (!url || url.trim().length === 0) return null;
  const endpoint = url.trim();

  let parsed: URL | null = null;
  try { parsed = new URL(endpoint); } catch { parsed = null; }
  const configError = parsed === null
    ? "TF_ALERT_WEBHOOK_URL is set but is not a parseable URL (surrounding quotes or whitespace in the value?)"
    : (parsed.protocol !== "http:" && parsed.protocol !== "https:")
      ? `TF_ALERT_WEBHOOK_URL is set but its scheme is '${parsed.protocol}', not http(s)`
      : null;
  if (configError) {
    return {
      name: "webhook",
      notify: () => Promise.resolve({ ok: false, error: configError, outcome: "misconfigured" }),
    };
  }

  return {
    name: "webhook",
    async notify(alerts, ctx) {
      try {
        const body = JSON.stringify({
          // `text`/`title` are what a chat webhook renders; everything else is ignored by
          // the ones that do not understand it and consumed by the ones that do.
          title: `ohmail ${ctx.environment}: ${alerts.length} alert(s)`,
          text: renderAlertText(alerts, ctx),
          source: ctx.source,
          environment: ctx.environment,
          firedAt: ctx.now.toISOString(),
          alerts: alerts.map((a) => ({
            key: a.key, kind: a.kind, severity: a.severity,
            title: a.title, detail: a.detail, count: a.count, oldestSeconds: a.oldestSeconds,
          })),
        });
        const res = await post(endpoint, body);
        if (res.status >= 200 && res.status < 300) return { ok: true, outcome: "ok" };
        return {
          ok: false,
          outcome: "refused",
          error: redactEndpoint(
            `HTTP ${res.status}${res.body ? ` — ${res.body}` : ""}`, endpoint,
          ),
        };
      } catch (err) {
        // A sink NEVER throws: the other sink must still get its chance. It does now say what
        // happened — `AbortError` (the 8 s timeout), `TypeError: fetch failed` with an
        // `ENOTFOUND`/`ECONNREFUSED` cause, a TLS failure — because "the webhook refused" with
        // no reason attached is the state this whole file spent months in.
        const e = err as { name?: string; message?: string; cause?: { message?: string; code?: string } };
        const cause = e?.cause?.code ?? e?.cause?.message ?? "";
        const text = `${e?.name ?? "Error"}: ${e?.message ?? String(err)}${cause ? ` (${cause})` : ""}`;
        return { ok: false, outcome: classifyTransportError(err), error: redactEndpoint(text, endpoint) };
      }
    },
  };
}

/** The plain-text body every sink can fall back to. Counts and ages only — never mail. */
export function renderAlertText(alerts: readonly Alert[], ctx: AlertNotifyContext): string {
  const head = `ohmail ${ctx.environment} — ${alerts.length} alert(s) firing (observed by ${ctx.source})`;
  const body = alerts.map((a) => `• [${a.severity}] ${a.title}\n  ${a.detail}`).join("\n");
  return `${head}\n\n${body}`;
}

/**
 * Every sink is tried; the pass reports which of them accepted, and why the rest did not.
 *
 * `errors` holds one `"<sink>: <reason>"` entry per sink that refused AND said something.
 *
 * **A FLAT ARRAY, NOT A RECORD KEYED BY SINK NAME**, and the reason is not taste: the logger's
 * field census (`ALLOWED_FIELDS` in `packages/core/src/log.ts`) gates keys at every depth, so
 * `{ webhook: "HTTP 429" }` would have had `webhook` dropped as an unknown field and the line
 * would have carried an empty object. Array elements inherit their parent key's verdict, so
 * this shape survives the gate and still names the sink.
 *
 * A sink that throws in spite of its contract is caught here and gets the exception's own text
 * — the one place the reason is NOT vetted by a sink, so it is labelled `threw:` for a reader.
 */
export async function deliver(
  sinks: readonly AlertSink[], alerts: readonly Alert[], ctx: AlertNotifyContext,
): Promise<DeliveryReport> {
  const delivered: string[] = [];
  const failed: string[] = [];
  const errors: string[] = [];
  const outcomes: SinkOutcome[] = [];
  for (const sink of sinks) {
    let ok = false;
    let error: string | null = null;
    let outcome: AlertSinkOutcome | null = null;
    try {
      const out = await sink.notify(alerts, ctx);
      if (typeof out === "boolean") ok = out;
      else { ok = out.ok; error = out.error ?? null; outcome = out.outcome ?? null; }
    } catch (err) {
      ok = false;
      outcome = "threw";
      error = `threw: ${(err as { message?: string })?.message ?? String(err)}`.slice(0, 200);
    }
    // A sink that says nothing about its outcome still gets a code: the bare `boolean` return
    // is not deprecated, so the DEFAULT has to be honest rather than absent. `refused` is the
    // conservative reading of a failure that declined to explain itself — it claims only that
    // the delivery did not happen, never that the network was at fault.
    outcomes.push({ sink: sink.name, ok, outcome: outcome ?? (ok ? "ok" : "refused"), error });
    if (ok) { delivered.push(sink.name); continue; }
    failed.push(sink.name);
    if (error) errors.push(`${sink.name}: ${error}`);
  }
  return { delivered, failed, errors, outcomes };
}

/** One sink's verdict on one delivery attempt, as {@link deliver} saw it. */
export interface SinkOutcome {
  sink: string;
  ok: boolean;
  outcome: AlertSinkOutcome;
  /** The sink's own stated reason, already redacted by the sink. Null when it said nothing. */
  error: string | null;
}

export interface DeliveryReport {
  delivered: string[];
  failed: string[];
  errors: string[];
  /** One entry per sink ATTEMPTED, in sink order. The per-sink half of the same story. */
  outcomes: SinkOutcome[];
}

/* ════════════════════════════════════════════════════════════════════════════════════════
   The pass — evaluate, remember, notify, resolve
   ════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * How long one pass's CLAIM on a notification survives before another pass may take it.
 *
 * See {@link runAlertPass}. It bounds the only window in which a page can be lost: a driver
 * that claims an alert and then dies before delivering it. Two minutes is long enough to
 * cover the slowest possible delivery (two sinks × the 8 s webhook timeout, plus a Resend
 * round trip) by a wide margin, and short enough that a killed pass costs one cycle rather
 * than the full one-hour repeat interval.
 */
export const DEFAULT_CLAIM_TTL_MS = 2 * 60 * 1000;

/**
 * How many CONSECUTIVE full-delivery failures make a configured sink an emergency.
 *
 * ── WHY THIS NUMBER, GIVEN THE CADENCE ───────────────────────────────────────────────────
 *
 * The worker runs a pass every 60 s, and a pass that delivers nothing RELEASES its claim (see
 * {@link runAlertPass}), so a firing alert against a broken sink is retried every 60 s — not
 * once per {@link DEFAULT_ALERT_REPEAT_MS}. Three consecutive failures is therefore about
 * three minutes of continuous refusal, across three independent attempts each with its own 8 s
 * timeout.
 *
 * Lower (1 or 2) and a single transient — one 502 from the receiving service, one DNS blip, a
 * redeploy of the chat app on the other end — emits the loudest ERROR this file has, which is
 * how an emergency signal gets filtered. Higher and the escalation drifts past the one-hour
 * repeat interval, which would mean the FIRST page of an incident is already lost before
 * anyone is told the pager is broken; three keeps the escalation inside the same alert that
 * would otherwise have paged, rather than an hour behind it.
 *
 * It is a count of ATTEMPTS, not of minutes, so it holds for the external observer too — that
 * driver runs on a slower schedule and simply needs three of its own runs.
 */
export const DEFAULT_SINK_FAILURE_ESCALATION = 3;

/**
 * The caller-owned memory behind "N consecutive failures".
 *
 * ── WHY THIS IS THE CALLER'S OBJECT AND NOT A TABLE ──────────────────────────────────────
 *
 * A streak is a property of one long-lived driver's experience of one sink, and the WORKER is
 * the always-on driver — it holds this for the whole life of its leadership, which is exactly
 * the scope over which "three in a row" means anything. Putting it in Postgres would buy
 * durability across a restart and cost a migration, a row every pass has to write, and another
 * table on the `ohmail_admin` grant — for a counter whose worst-case loss is that a restart
 * costs three minutes of escalation latency and then the streak rebuilds.
 *
 * Stated rather than discovered: on a SERVERLESS driver this only accumulates while one
 * instance stays warm, so the external observer escalates less reliably than the worker does.
 * That is the right way round — the worker is the driver that owns the sink and runs every
 * minute, and the observer's own job (`worker_down`) is unaffected.
 *
 * {@link runAlertPass} MUTATES this. It is passed rather than returned so a caller cannot
 * forget to store it back and silently never escalate.
 */
export interface DeliveryStreak {
  /** Consecutive delivery ATTEMPTS in which not one sink accepted. */
  consecutiveFailures: number;
  /** Whether the current streak has already been escalated. One ERROR per streak. */
  escalated: boolean;
  /**
   * The SAME memory, per sink — and the reason it had to exist the moment a second vendor did.
   *
   * ── THE HOLE A SECOND ARM OPENS, WHICH THE FIRST ONE COULD NOT HAVE ─────────────────────
   *
   * The counter above is global, and it is cleared by ANY success. That was right while the
   * question was only "did an alert reach a human" — with one arm, one arm's failure IS total
   * failure. Add a second vendor and the same rule silently inverts: an arm that has refused
   * every delivery for a month keeps its streak cleared by the OTHER arm's successes, so the
   * deployment reports a healthy pager, is told nothing, and has exactly one working arm — the
   * single-vendor state it just paid to leave, now invisible instead of merely bad.
   *
   * Redundancy you cannot observe is not redundancy; it is one arm and a false belief. So each
   * sink keeps its own streak, and losing one arm while the other still delivers is its own
   * named alarm ({@link SinkDegradation}) rather than a silence.
   */
  sinks: Record<string, SinkStreak>;
}

/** One sink's experience of this driver, across passes. See {@link DeliveryStreak.sinks}. */
export interface SinkStreak {
  /** Consecutive delivery attempts THIS sink refused. Cleared by its own success only. */
  consecutiveFailures: number;
  /** Whether this sink's current streak has been reported. One report per streak. */
  escalated: boolean;
  /** The closed code from its most recent attempt, or null — it has never been attempted. */
  lastOutcome: AlertSinkOutcome | null;
  /** ISO of the last delivery this sink ACCEPTED, or null — it has never delivered one. */
  lastOkAt: string | null;
  /** Delivery attempts made through this sink. `0` is not health; it is absence of evidence. */
  attempts: number;
}

export function newSinkStreak(): SinkStreak {
  return { consecutiveFailures: 0, escalated: false, lastOutcome: null, lastOkAt: null, attempts: 0 };
}

export function newDeliveryStreak(): DeliveryStreak {
  return { consecutiveFailures: 0, escalated: false, sinks: {} };
}

/** Emitted on the ONE pass where a streak crosses the threshold. */
export interface SinkEscalation {
  consecutiveFailures: number;
  /** The sinks that refused on the crossing attempt. */
  sinks: string[];
  /** `"<sink>: <reason>"` for each that said anything. Flat — see {@link deliver}. */
  errors: string[];
}

/**
 * ONE ARM OF THE PAGER IS DEAD AND THE PAGES ARE STILL LANDING.
 *
 * Emitted on the one pass where an INDIVIDUAL sink's own streak crosses the threshold while
 * something else delivered. {@link SinkEscalation} is the other half — every arm down, nothing
 * reaching anybody — and the two are deliberately disjoint alarms for two different faults,
 * exactly as `undeliverable` and `escalate` already are.
 *
 * This one is the quieter fault and the more dangerous posture: nothing is failing that a
 * human can feel, and the next vendor outage is now total. It is reported at ERROR anyway,
 * because the cost of learning it during the outage is the whole reason a second arm exists.
 *
 * Not emitted on a pass where NOTHING delivered: that pass belongs to {@link SinkEscalation},
 * and two alarms for one silence is how a real one gets filtered. The per-sink streak still
 * advances underneath, so the dead arm is named the moment the other one comes back.
 */
export interface SinkDegradation {
  sink: string;
  consecutiveFailures: number;
  /** The closed code from the crossing attempt. */
  outcome: AlertSinkOutcome;
  /** This sink's own stated reason, already redacted by it. Null when it said nothing. */
  error: string | null;
  /** The sinks that DID accept — what redundancy is left, named rather than implied. */
  survivors: string[];
}

export interface AlertPassOptions extends EvaluateOptions {
  sinks?: readonly AlertSink[];
  /** How long a still-firing alert waits before paging again. Default one hour. */
  repeatMs?: number;
  /**
   * Where the consecutive-failure count for this driver lives. Omit and the pass still
   * reports every failure, but nothing escalates — an occasional one-shot caller has no
   * streak to speak of.
   */
  deliveryStreak?: DeliveryStreak;
  /** Consecutive failures before escalating. Default {@link DEFAULT_SINK_FAILURE_ESCALATION}. */
  escalateAfter?: number;
  /**
   * How long this pass's claim on a notification lasts if the pass never finishes. Default
   * {@link DEFAULT_CLAIM_TTL_MS}. Tests set it small to make lease expiry observable.
   */
  claimTtlMs?: number;
  source?: string;
  environment?: string;
}

export interface AlertPassResult {
  now: string;
  /** Everything currently wrong. */
  firing: Alert[];
  /** The subset this pass actually notified about (new, or past the repeat interval). */
  notified: Alert[];
  /** Alert keys that were firing and are not any more. */
  resolved: string[];
  delivered: string[];
  failedSinks: string[];
  /** `"<sink>: <reason>"` for each refusal that stated one. Empty when nothing refused. */
  sinkErrors: string[];
  /** True when there were alerts to send and not one sink was CONFIGURED. */
  undeliverable: boolean;
  /**
   * Consecutive delivery attempts, including this one, in which no sink accepted. `0` when
   * this pass delivered, and unchanged when this pass had nothing to deliver — an absence of
   * attempts is not evidence of health, so it neither counts nor clears.
   */
  sinkFailureStreak: number;
  /**
   * Non-null on the ONE pass where the streak reaches the threshold. The caller logs this at
   * ERROR: a CONFIGURED sink that refuses everything is the same state as no sink at all, and
   * it was the one the original `undeliverable` flag could not see.
   */
  escalate: SinkEscalation | null;
  /** One entry per sink attempted on THIS pass, with its closed code. Empty when nothing was. */
  sinkOutcomes: SinkOutcome[];
  /**
   * The arms that just crossed their OWN failure threshold while the page still landed
   * elsewhere — redundancy lost, silently, which is the failure a second vendor is bought to
   * prevent and the one adding it creates. Empty on almost every pass. See
   * {@link SinkDegradation}.
   */
  sinkDegraded: SinkDegradation[];
  /**
   * Every CONFIGURED sink's standing health, whether or not this pass attempted it — the
   * snapshot `/health` publishes. A sink that has never been attempted appears with
   * `attempts: 0`, because an arm nobody has exercised is not evidence of anything and the
   * surface has to say so rather than leave it out.
   */
  sinkHealth: AlertSinkHealth[];
}

/** One sink's standing health, as published. Closed codes only — see {@link sinkHealthOf}. */
export interface AlertSinkHealth {
  name: string;
  /** Its most recent closed code, or null — never attempted. */
  outcome: AlertSinkOutcome | null;
  consecutiveFailures: number;
  attempts: number;
  lastOkAt: string | null;
}

/**
 * The standing health of every CONFIGURED sink — the shape `/health` publishes.
 *
 * Driven off the sink LIST rather than off the streak record, so an arm that has never been
 * attempted is present and says `attempts: 0` instead of being absent. That difference is the
 * whole point: "not in the list" and "in the list, never exercised" read identically to a
 * reader and mean opposite things, and the second is the state a freshly-configured second
 * vendor is in for its first quiet hour.
 *
 * NO PROSE. Every field here is a name, a closed code, a count or a timestamp — the sink's own
 * `error` sentence is vendor-authored and unbounded and stays in the log line, where a drain
 * gates it, rather than on an endpoint anybody can read.
 */
export function sinkHealthOf(
  sinks: readonly AlertSink[], streak: DeliveryStreak | undefined,
): AlertSinkHealth[] {
  return sinks.map((sink) => {
    const s = streak?.sinks?.[sink.name];
    return {
      name: sink.name,
      outcome: s?.lastOutcome ?? null,
      consecutiveFailures: s?.consecutiveFailures ?? 0,
      attempts: s?.attempts ?? 0,
      lastOkAt: s?.lastOkAt ?? null,
    };
  });
}

/**
 * Run one full pass: evaluate, reconcile against `alert_state`, notify what is new or overdue,
 * clear what has resolved.
 *
 * ## Two drivers write this table, so "have we paged yet?" is a RACE, not a read
 *
 * The worker runs this every 60 s and the external observer runs it on its own schedule
 * (`packages/api/src/routes/internal.ts`), and the whole point of the second one is that it
 * keeps running when the first is dead — which means both run at once whenever the first is
 * merely fine. The obvious implementation, "read `notified_at`, decide, deliver, stamp", pages
 * twice: both drivers read `notified_at IS NULL`, both deliver, both stamp. `alert_state`'s
 * notify-once semantics were never enforced by the database, only by the assumption of a
 * single writer, and that assumption is exactly what the external observer removes.
 *
 * So the decision to notify is a CLAIM — one conditional UPDATE, which Postgres serialises on
 * the row:
 *
 * ```
 *   UPDATE alert_state SET notified_at = <lease>
 *    WHERE alert_key = $k AND (notified_at IS NULL OR notified_at <= $now - repeatMs)
 * ```
 *
 * The winner gets a row back and notifies; the loser blocks on the row lock, re-checks the
 * predicate against the committed new value, matches nothing, and stays quiet. No advisory
 * lock and no surrounding transaction, deliberately: {@link deliver} does network I/O, and
 * holding a Postgres transaction open across an HTTP call is the `idle in transaction`
 * pathology that caused the outage this observer exists to catch.
 *
 * ## The claim is a LEASE, so a pass that dies mid-delivery does not swallow the page
 *
 * `notified_at` is not stamped with `now` at claim time — it is stamped `now - repeatMs +
 * claimTtlMs`, a value that is past the due cutoff (so no concurrent pass can claim it) and
 * that becomes due again exactly `claimTtlMs` later. Then:
 *
 *  · at least one sink accepted ⇒ **confirm**: `notified_at = now`, `notify_count + 1`;
 *  · nothing accepted ⇒ **release**: `notified_at` goes back to what it was;
 *  · the pass dies in between ⇒ nobody writes anything, and the lease expires on its own.
 *
 * Both writes are guarded by `notified_at = <the lease value we wrote>`, so a pass can only
 * ever undo its OWN claim — if the condition resolved and the row was deleted underneath, or
 * another driver re-claimed after the lease expired, the guard matches nothing and that is the
 * correct outcome.
 *
 * The direction of every failure is preserved and is the one a pager needs: an undelivered
 * alert is retried (a misconfigured webhook stays self-correcting rather than becoming a
 * silent hole), and a crashed pass costs at most `claimTtlMs` of delay instead of the full
 * repeat interval. A duplicate page is an annoyance; a swallowed one is the whole problem this
 * file exists to solve.
 *
 * Never throws for a delivery failure; a DB failure does propagate, because a pass that
 * cannot read the database has not evaluated anything and must not report "all clear".
 */
export async function runAlertPass(db: Tx, opts: AlertPassOptions = {}): Promise<AlertPassResult> {
  const now = opts.now ?? new Date();
  const repeatMs = opts.repeatMs ?? DEFAULT_ALERT_REPEAT_MS;
  const claimTtlMs = opts.claimTtlMs ?? DEFAULT_CLAIM_TTL_MS;
  const shards = opts.shards ?? [0];
  const sinks = opts.sinks ?? [];
  const firing = await evaluateAlerts(db, opts);
  const firingKeys = new Set(firing.map((a) => a.key));

  const existing = await db
    .select({
      alertKey: alertState.alertKey,
      kind: alertState.kind,
      notifiedAt: alertState.notifiedAt,
      notifyCount: alertState.notifyCount,
    })
    .from(alertState);
  const byKey = new Map(existing.map((r) => [r.alertKey, r]));

  // ── record the observation (opened_at survives an UPSERT; last_seen_at advances) ──────
  //
  // BEFORE the claim, not after: the claim is an UPDATE, so the row has to exist for a first
  // observation to be claimable at all.
  for (const alert of firing) {
    await db
      .insert(alertState)
      .values({
        alertKey: alert.key,
        kind: alert.kind,
        severity: alert.severity,
        openedAt: now,
        lastSeenAt: now,
        notifyCount: 0,
        detail: alert.detail,
      })
      .onConflictDoUpdate({
        target: alertState.alertKey,
        // `opened_at` is NOT in the update set: it is when the fault STARTED, and an
        // operator asking "how long has this been broken" is asking about that value.
        set: { lastSeenAt: now, severity: alert.severity, detail: alert.detail, kind: alert.kind },
      });
  }

  // ── CLAIM the notifications this pass is allowed to send ──────────────────────────────
  //
  // One conditional UPDATE per firing alert, and the row it does or does not return IS the
  // decision. See the header: the predicate is the old in-memory `due` test moved into the
  // database, which is what makes it safe against a second driver running the same pass.
  //
  // Drizzle COLUMN operators, never a raw `sql` fragment with a `Date` in it — the rule the
  // sync-lag rule above states at length. The column on the left is what lets drizzle bind
  // these as timestamptz instead of letting postgres-js describe the parameter as TEXT.
  const dueBefore = new Date(now.getTime() - repeatMs);
  const lease = new Date(dueBefore.getTime() + claimTtlMs);
  const claimed: Array<{ alert: Alert; prior: Date | null }> = [];
  for (const alert of firing) {
    const won = await db
      .update(alertState)
      .set({ notifiedAt: lease })
      .where(and(
        eq(alertState.alertKey, alert.key),
        or(isNull(alertState.notifiedAt), lte(alertState.notifiedAt, dueBefore)),
      ))
      .returning({ alertKey: alertState.alertKey });
    if (won.length === 0) continue;
    // What to put back if nothing accepts this alert. Read at the top of the pass, and safe
    // to use precisely BECAUSE the claim succeeded: any concurrent confirm would have moved
    // `notified_at` past `dueBefore` and this UPDATE would have matched nothing.
    const priorRaw = byKey.get(alert.key)?.notifiedAt ?? null;
    claimed.push({ alert, prior: priorRaw ? new Date(priorRaw as unknown as string) : null });
  }
  const toNotify = claimed.map((c) => c.alert);

  // ── resolve what is no longer firing ──────────────────────────────────────────────────
  //
  // DELETE rather than a `resolved_at` column: `alert_state` is then a live list of what is
  // wrong, which is both what the console wants to render and what makes "did this page
  // already?" a single row lookup. The history that matters is the log line, which is
  // structured and timestamped and is not going to be queried by this table.
  //
  // ── BUT A PASS MAY ONLY RESOLVE WHAT IT ACTUALLY EVALUATED ────────────────────────────
  //
  // `worker_down` is the one rule a pass can decline to evaluate, and the WORKER declines it
  // (`shards: []` — a process cannot testify to its own liveness). "Not in my firing set" is
  // therefore not the same statement as "no longer true" for that rule: to a worker pass,
  // `worker_down:0` is never firing, so an unscoped resolve would have the worker DELETE the
  // row the external observer had just opened. The consequence is not a missed page but a
  // flapping one — open, page, deleted, re-opened with `notified_at` back to NULL, paged
  // again on the next external pass, for ever, with `opened_at` reset each time so "how long
  // has this been broken" reads as seconds. Latent until an external driver existed; live the
  // moment one does.
  //
  // Residue, stated rather than discovered: a `worker_down:S` row for a shard NO pass
  // evaluates any more (a shard removed from the configuration) is never resolved here and
  // has to be deleted by hand. That is the safe direction — the alternative is the flap above
  // — and with one shipped shard it is not a state this deployment can reach.
  const evaluatedWorkerKeys = new Set(shards.map((s) => `worker_down:${s}`));
  const resolved = existing
    .filter((r) => !firingKeys.has(r.alertKey))
    .filter((r) => r.kind !== "worker_down" || evaluatedWorkerKeys.has(r.alertKey))
    .map((r) => r.alertKey);
  for (const key of resolved) {
    await db.delete(alertState).where(eq(alertState.alertKey, key));
  }

  const streak = opts.deliveryStreak;
  if (toNotify.length === 0) {
    // Nothing was ATTEMPTED, so the streak is neither advanced nor cleared. A quiet hour is
    // not evidence that the pager works — that was the whole shape of the bug this reports.
    return {
      now: now.toISOString(), firing, notified: [], resolved,
      delivered: [], failedSinks: [], sinkErrors: [], undeliverable: false,
      sinkFailureStreak: streak?.consecutiveFailures ?? 0, escalate: null,
      sinkOutcomes: [], sinkDegraded: [],
      // Published on a pass that attempted nothing, and that is the point: standing health is
      // what the last ATTEMPT established, and a quiet pass neither confirms nor disturbs it.
      sinkHealth: sinkHealthOf(sinks, streak),
    };
  }

  const ctx: AlertNotifyContext = {
    source: opts.source ?? "api",
    environment: opts.environment ?? "production",
    now,
  };
  const { delivered, failed, errors, outcomes } = await deliver(sinks, toNotify, ctx);

  // ── the streak, and the ONE escalation it is allowed ──────────────────────────────────
  //
  // A pass with no sink configured does NOT count here. That state already reports itself on
  // every single pass through `undeliverable`, which is louder than this is; folding the two
  // together would mean the no-sink alarm goes quiet after its first escalation. They are
  // deliberately disjoint alarms for two different faults: nothing configured, and
  // everything configured and refusing.
  let escalate: SinkEscalation | null = null;
  const sinkDegraded: SinkDegradation[] = [];
  const threshold = opts.escalateAfter ?? DEFAULT_SINK_FAILURE_ESCALATION;
  if (streak && sinks.length > 0) {
    // A streak object built before per-sink memory existed — a stale compiled `dist/` in
    // another package is the reachable way to get one — would make every read below throw on
    // `undefined`. An observability feature may never be the thing that breaks the pass.
    if (!streak.sinks) streak.sinks = {};

    // ── each ARM's own memory, kept whatever the aggregate did ────────────────────────────
    for (const o of outcomes) {
      const per = (streak.sinks[o.sink] ??= newSinkStreak());
      per.attempts += 1;
      per.lastOutcome = o.outcome;
      if (o.ok) {
        per.consecutiveFailures = 0;
        per.escalated = false;
        per.lastOkAt = now.toISOString();
      } else {
        per.consecutiveFailures += 1;
      }
    }

    if (delivered.length > 0) {
      // ANY success clears the AGGREGATE, including a success on a different sink than the one
      // failing: the question this answers is "did an alert reach a human", not "is every sink
      // well". That second question is the per-arm loop above, and it is asked here — a pass
      // that delivered is exactly the pass on which a dead arm would otherwise be invisible.
      streak.consecutiveFailures = 0;
      streak.escalated = false;
      for (const o of outcomes) {
        if (o.ok) continue;
        const per = streak.sinks[o.sink];
        if (!per || per.escalated || per.consecutiveFailures < threshold) continue;
        per.escalated = true;
        sinkDegraded.push({
          sink: o.sink,
          consecutiveFailures: per.consecutiveFailures,
          outcome: o.outcome,
          error: o.error,
          survivors: [...delivered],
        });
      }
    } else {
      streak.consecutiveFailures += 1;
      if (streak.consecutiveFailures >= threshold && !streak.escalated) {
        streak.escalated = true;
        escalate = { consecutiveFailures: streak.consecutiveFailures, sinks: [...failed], errors };
      }
      // Per-arm reports are deliberately NOT emitted here — see {@link SinkDegradation}. The
      // per-arm counters above still advanced, and their `escalated` flags are still false, so
      // an arm that stayed dead is named on the first pass the other one recovers.
    }
  }

  // ── settle every claim: CONFIRM if something accepted, otherwise RELEASE ───────────────
  //
  // Guarded by `notified_at = lease` so a pass can only undo its own claim. A row that was
  // deleted as resolved, or re-claimed by another driver after this lease expired, matches
  // nothing — and in both cases doing nothing is right.
  //
  // Releasing is what keeps a misconfigured webhook self-correcting rather than a silent
  // hole, and `notify_count` moves ONLY on a confirm, so it counts pages that were actually
  // accepted by a sink and never claims that failed.
  for (const { alert, prior } of claimed) {
    const settle = delivered.length > 0
      ? { notifiedAt: now, notifyCount: sql`${alertState.notifyCount} + 1` }
      : { notifiedAt: prior };
    await db
      .update(alertState)
      .set(settle)
      .where(and(eq(alertState.alertKey, alert.key), eq(alertState.notifiedAt, lease)));
  }

  return {
    now: now.toISOString(),
    firing,
    notified: toNotify,
    resolved,
    delivered,
    failedSinks: failed,
    sinkErrors: errors,
    undeliverable: sinks.length === 0,
    sinkFailureStreak: streak?.consecutiveFailures ?? 0,
    escalate,
    sinkOutcomes: outcomes,
    sinkDegraded,
    sinkHealth: sinkHealthOf(sinks, streak),
  };
}

/* ════════════════════════════════════════════════════════════════════════════════════════
   The heartbeat — written by the leader, read by everyone
   ════════════════════════════════════════════════════════════════════════════════════════ */

export interface HeartbeatInput {
  shardIndex: number;
  instanceId: string;
  shards: number;
  mailboxes: number;
  expected: number;
  accounts: number;
  quarantined: number;
  degraded: boolean;
  lastCycleAt: Date | null;
  startedAt: Date;
}

/**
 * Stamp this leader's pulse — the CLAIMING write. Called by the worker on every cycle and
 * roster pass.
 *
 * ONLY the process holding shard N's advisory lock may call this — the row IS "the leader of
 * shard N", and a standby writing it would make a shard with no leader look alive. The
 * worker enforces that by calling it from inside the lock-held body only.
 *
 * ── TWO WRITE MODES, AND THE DIFFERENCE IS LOAD-BEARING ─────────────────────────────────
 *
 * This one UPSERTS and asserts `leader = true`, so it both claims the shard and refreshes it.
 * That is correct for a call made ON the worker's serial queue, which is ordered against the
 * queued {@link clearHeartbeat} of a shutdown or a lost lock.
 *
 * {@link refreshHeartbeat} is the other mode: a guarded UPDATE for callers that are NOT on
 * that queue (the lock-verify timer), which can therefore race a surrender. It exists because
 * this function cannot be made safe for them — an upsert landing after `clearHeartbeat` would
 * rewrite `leader: true` for a process that has already quiesced, and the shard would look led
 * for the whole `leaderStaleMs` window while nothing synced. Pick by call site, not by taste.
 *
 * Best-effort by contract: the caller must not let a failed heartbeat abort a sync cycle.
 * A missed beat is at worst a false alarm; a cycle aborted because bookkeeping failed is a
 * real outage caused by the observability code.
 */
export async function writeHeartbeat(db: Tx, input: HeartbeatInput, now: Date = new Date()): Promise<void> {
  await db
    .insert(workerHeartbeats)
    .values({
      shardIndex: input.shardIndex,
      instanceId: input.instanceId,
      leader: true,
      shards: input.shards,
      mailboxes: input.mailboxes,
      expected: input.expected,
      accounts: input.accounts,
      quarantined: input.quarantined,
      degraded: input.degraded,
      lastCycleAt: input.lastCycleAt,
      startedAt: input.startedAt,
      beatAt: now,
    })
    .onConflictDoUpdate({
      target: workerHeartbeats.shardIndex,
      set: {
        instanceId: input.instanceId,
        leader: true,
        shards: input.shards,
        mailboxes: input.mailboxes,
        expected: input.expected,
        accounts: input.accounts,
        quarantined: input.quarantined,
        degraded: input.degraded,
        lastCycleAt: input.lastCycleAt,
        startedAt: input.startedAt,
        beatAt: now,
      },
    });
}

/** What a refresh may move. Identity (`shards`, `startedAt`) is fixed by the claiming write. */
export type HeartbeatRefresh = Omit<HeartbeatInput, "shards" | "startedAt">;

/**
 * Refresh a pulse this instance ALREADY OWNS — the write for callers not on the worker's
 * serial queue.
 *
 * ── THE RACE THIS EXISTS TO CLOSE ────────────────────────────────────────────────────────
 *
 * The worker's beats used to happen only at the end of a cycle or an attach, which meant a
 * leader spending three minutes draining one mailbox's first sync wrote nothing at all for
 * three minutes. From the outside that is indistinguishable from a dead process: the
 * `worker_down` rule above reads `leader` + `beat_at` staleness and nothing else, so a
 * perfectly healthy backfill pages a human at two minutes and the hosting platform is entitled to replace
 * the instance mid-drain. The fix is to beat on a timer instead of at the end of the work.
 *
 * But a timer is exactly the caller that can race a surrender. `clearHeartbeat` runs ON the
 * queue; a timer callback does not, so its write can be in flight when the lock is lost and
 * land AFTER the surrender — and an upsert would then resurrect `leader: true` for a process
 * that has already detached every mailbox. Guarding it in the worker with a `stopped` flag
 * only narrows the window: the check and the write are not atomic.
 *
 * So the guard is in the STATEMENT, where it is atomic:
 *
 *   · `WHERE shard_index = ?` — this shard;
 *   · `AND instance_id = ?` — and still THIS process. A takeover has already overwritten the
 *     row with its own id, so the outgoing instance's late refresh matches nothing;
 *   · `AND leader = true` — and not yet surrendered. After `clearHeartbeat` this is false and
 *     stays false until a real claiming write.
 *
 * Zero rows matched is the correct, silent outcome — the caller has nothing to report and
 * nothing to retry. There is NO INSERT: a refresh can never create the row, so it can never
 * announce a leader that never claimed the shard.
 *
 * `beat_at` moves, and so do the counters, because a beat that carried stale counts would be
 * a liveness signal wearing a lie. `last_cycle_at` is refreshed from the caller's value and
 * therefore keeps its own meaning: it advances only on a cycle that actually synced, so
 * "alive but syncing nothing" stays a DIFFERENT fault from "dead" — which is the whole reason
 * that column is separate from `beat_at`.
 */
export async function refreshHeartbeat(
  db: Tx, input: HeartbeatRefresh, now: Date = new Date(),
): Promise<void> {
  await db
    .update(workerHeartbeats)
    .set({
      mailboxes: input.mailboxes,
      expected: input.expected,
      accounts: input.accounts,
      quarantined: input.quarantined,
      degraded: input.degraded,
      lastCycleAt: input.lastCycleAt,
      beatAt: now,
    })
    .where(and(
      eq(workerHeartbeats.shardIndex, input.shardIndex),
      eq(workerHeartbeats.instanceId, input.instanceId),
      eq(workerHeartbeats.leader, true),
    ));
}

/** Who is surrendering: the shard, and the instance that must still own it to be allowed to. */
export type HeartbeatSurrender = Pick<HeartbeatInput, "shardIndex" | "instanceId">;

/**
 * Mark this shard as having NO leader — called on a clean shutdown and on a lost lock.
 *
 * Without it, a graceful stop leaves the last beat behind and the shard looks alive for the
 * full `leaderStaleMs` window. Setting `leader = false` makes the handover visible
 * immediately: a standby that takes over overwrites it within its first cycle, and one that
 * never arrives is reported at the next pass instead of two minutes later.
 *
 * ── AND IT IS FENCED BY INSTANCE ID, FOR THE SAME REASON `refreshHeartbeat` IS ─────────────
 *
 * This used to update `WHERE shard_index = ?` alone, which made a SURRENDER able to clobber
 * somebody else's CLAIM. The sequence is a routine deploy: worker A loses its lock and queues
 * `clearHeartbeat` behind whatever cycle is in flight; worker B acquires the lock, attaches the
 * shard's mailboxes and claims the row with its own `instance_id`; A's queued surrender then
 * lands and sets `leader = false` on B's row. B's next pulse is a GUARDED update — it requires
 * `leader = true` — so it matches nothing and quietly does not beat, and the shard reads as
 * leaderless (and pages) until B's next serial-queue `writeHeartbeat` upserts it back. The
 * live worker is reported down while it is serving mail.
 *
 * `AND instance_id = ?` closes it: after a takeover the outgoing instance's surrender matches no
 * row, which is the correct, silent outcome — B's claim IS the announcement that A is gone, and
 * there is nothing left for A to hand back. `AND leader = true` is the second half of the same
 * thought: a shard already surrendered does not need surrendering twice.
 */
export async function clearHeartbeat(
  db: Tx, who: HeartbeatSurrender, now: Date = new Date(),
): Promise<void> {
  await db
    .update(workerHeartbeats)
    .set({ leader: false, beatAt: now })
    .where(and(
      eq(workerHeartbeats.shardIndex, who.shardIndex),
      eq(workerHeartbeats.instanceId, who.instanceId),
      eq(workerHeartbeats.leader, true),
    ));
}

/* ════════════════════════════════════════════════════════════════════════════════════════
   The two operator queues the admin console renders
   ════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * A `billing_events` row that failed to apply.
 *
 * NOTE WHAT IS ABSENT: `payload`. The Stripe event body is the one field on this table that
 * could carry a customer's name, address or line-item description, and no operator queue
 * needs it — the identity (`stripeEventId`) is what you paste into the Stripe dashboard, and
 * `error` is what tells you why it failed. The projection is the privacy boundary, exactly as
 * the operator console's own DTO layer is for its screens.
 */
export interface FailedBillingEventRow {
  stripeEventId: string;
  type: string;
  accountId: string | null;
  error: string | null;
  eventTs: Date;
  receivedAt: Date;
}

export async function listFailedBillingEvents(db: Tx, limit = 50): Promise<FailedBillingEventRow[]> {
  const rows = await db
    .select({
      stripeEventId: billingEvents.stripeEventId,
      type: billingEvents.type,
      accountId: billingEvents.accountId,
      error: billingEvents.error,
      eventTs: billingEvents.eventTs,
      receivedAt: billingEvents.receivedAt,
    })
    .from(billingEvents)
    .where(eq(billingEvents.status, "failed"))
    .orderBy(billingEvents.receivedAt)
    .limit(limit);
  return rows.map((r) => ({
    ...r,
    eventTs: new Date(r.eventTs as unknown as string),
    receivedAt: new Date(r.receivedAt as unknown as string),
  }));
}

/**
 * An `outbound_sends` row stuck in `pending`.
 *
 * Identified by its ID and its age. Deliberately no draft content, no recipient, no minted
 * message id — the same projection the operator console's `StaleSend` type already declares,
 * so the console renders this without widening its seam.
 *
 * ── `idempotencyKey` IS GONE FROM THE PROJECTION, and that is the point ────────────────────
 *
 * It was selected here and then dropped by `admin-service.ts` (the staff-surface hardening
 * removed it from the DTO
 * because it is the CLIENT's `Idempotency-Key` header, verbatim and unvalidated — caller-chosen
 * free text of unbounded length, and a client that used a draft's SUBJECT as its "one intent"
 * token would have put subjects on a staff screen). Selecting a column and discarding it is not
 * a projection: Postgres requires the SELECT privilege on every column a statement REFERENCES,
 * so keeping it here would have forced `outbound_sends.idempotency_key` into the `ohmail_admin`
 * grant and reopened, at the role level, exactly what that hardening closed at the render level.
 *
 * The only consumer of this function is `admin-service.ts`, and `id` — which it already
 * returns, and which `admin.send.retry` will take — is 1:1 with the key.
 */
export interface StuckSendRow {
  id: string;
  accountId: string;
  status: string;
  createdAt: Date;
}

export async function listStuckSends(
  db: Tx, olderThan: Date, limit = 50,
): Promise<StuckSendRow[]> {
  const rows = await db
    .select({
      id: outboundSends.id,
      accountId: outboundSends.accountId,
      status: outboundSends.status,
      createdAt: outboundSends.createdAt,
    })
    .from(outboundSends)
    .where(and(eq(outboundSends.status, "pending"), lt(outboundSends.createdAt, olderThan)))
    .orderBy(outboundSends.createdAt)
    .limit(limit);
  return rows.map((r) => ({ ...r, createdAt: new Date(r.createdAt as unknown as string) }));
}

/**
 * Every live `alert_state` row — the console's "what is paging right now" list.
 *
 * **Projected explicitly, never `.select()`**. The re-projection below already fixed
 * the RETURNED shape, so a whole-row read leaked nothing and this was not a live defect. It was
 * the drift shape: the SELECT decided what left the database, the mapper decided what left the
 * function, and only the second one was reviewed. Add a column to `alert_state` that happens to
 * carry a subject line or a sender, and it crosses the boundary the moment it exists — no code
 * change, no review, nothing to notice. The staff-blindness rule is structural or it is nothing.
 *
 * `listStuckSends`, twenty lines up, already did it this way. The pair is the argument.
 */
export async function listOpenAlerts(db: Tx): Promise<Array<{
  alertKey: string; kind: string; severity: string; openedAt: Date;
  lastSeenAt: Date; notifiedAt: Date | null; notifyCount: number; detail: string | null;
}>> {
  const rows = await db
    .select({
      alertKey: alertState.alertKey,
      kind: alertState.kind,
      severity: alertState.severity,
      openedAt: alertState.openedAt,
      lastSeenAt: alertState.lastSeenAt,
      notifiedAt: alertState.notifiedAt,
      notifyCount: alertState.notifyCount,
      detail: alertState.detail,
    })
    .from(alertState)
    .where(isNotNull(alertState.alertKey))
    .orderBy(alertState.openedAt);
  return rows.map((r) => ({
    alertKey: r.alertKey,
    kind: r.kind,
    severity: r.severity,
    openedAt: new Date(r.openedAt as unknown as string),
    lastSeenAt: new Date(r.lastSeenAt as unknown as string),
    notifiedAt: r.notifiedAt ? new Date(r.notifiedAt as unknown as string) : null,
    notifyCount: Number(r.notifyCount),
    detail: r.detail,
  }));
}
