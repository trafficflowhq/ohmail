import { and, eq, gt, isNotNull, isNull, lt, lte, ne, or, sql } from "drizzle-orm";
import {
  alertPassRuns, alertState, authEvents, billingEvents, billingReconciliationRuns,
  creditRollupRuns, devices, mailboxes, outboundSends, platformSignals, sessions, workerHeartbeats,
} from "./schema.js";
import { accountsWithSyncDisabled } from "./billing.js";
import { accountsAtStorageCap } from "./storage-cloud.js";
import { imapRefusalsInWindow } from "./imap-admission.js";
import { aiUsageUnrecorded } from "./ai-usage.js";
import type { Tx } from "./change-log.js";

/**
 * THE ALERTS. One evaluator, one delivery pass, and two CLASSES of finding.
 *
 * (This header said "Seven rules" for as long as there were nine, then twelve. The count is
 * deliberately not restated: it is a number that goes stale on every slice and cannot be checked
 * by anything, and {@link AlertKind} is the list that is actually authoritative. A census test
 * asserts every kind in that union is reachable from {@link evaluateAlerts}.)
 *
 * ## Incidents and signals, which is the newest thing here
 *
 * Severity said how bad, and nothing said whether to WAKE somebody. `storage_at_cap` and
 * `sync_lag` were both warnings and only one of them was a customer being wronged, so the pager
 * carried both and an operator learned to skim it — which is the failure mode every rule in this
 * file is written against, arriving through the one door nothing guarded.
 *
 * {@link AlertClass} is that door. An INCIDENT is a real application problem: it is recorded, it
 * renders, and it goes to the sinks. A SIGNAL is informational: recorded and rendered, never
 * delivered. Two rules compute their class from POPULATION rather than fixing it — a handful of
 * lagging mailboxes is an observation and the same lag across a fifth of the deployment is an
 * outage — so the class is part of their signature and a promotion re-pages at once.
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
   *
   * Two arms share this kind and its per-device key. A device that STAMPED once and went quiet
   * is the original arm. A device that NEVER stamped (`last_synced_at IS NULL`) older than the
   * threshold, with a LIVE session and an account that moved on, is the second — added after
   * the first real incident showed the NULL exclusion was the exact blind spot: every wedged
   * mirror is NULL right up until the first time it converges, so "never-synced asserts
   * nothing" described precisely the population the alert existed for.
   */
  | "device_sync_stale"
  /**
   * A SESSION that used to reach the sync horizon is still making requests but has not
   * converged past the threshold while its account kept changing. Read from
   * `sessions.last_synced_at` (mail 0070) beside `sessions.last_seen_at`. This is the arm that
   * covers DEVICELESS installs — the browser-door desktop, a long-lived web tab — which hold
   * `device_id IS NULL` sessions (mail 0061) and are invisible to `device_sync_stale` by
   * construction. "Still making requests" is the discriminator that keeps a closed tab silent:
   * a wedged install rotates its refresh family and polls on its own backoff (the measured
   * incident: four rotations an hour for five days), while a tab someone closed stops
   * presenting anything and simply ages out.
   */
  | "session_sync_stale"
  /**
   * Refresh-token REUSE DETECTION revoked a session family inside the lookback window. Read
   * from `auth_events` (`event = 'refresh_reuse_revoked'`, written by the rotation's reuse
   * branch). Either a stolen token was replayed or a client's rotation is broken — both worth
   * a page, and before this row existed the only record was the raw session rows an operator
   * had to reconstruct after the fact (the Aug-21 incident). Keyed per account; auto-resolves
   * when the window slides past the newest event.
   */
  | "session_reuse_revoked"
  /**
   * The leader is beating but reporting itself DEGRADED for longer than the threshold — a
   * different fault from `worker_down` and one nothing paged about before. `degraded` is derived
   * from named causes (`DegradedCauses` in the worker), and a worker that is alive, holding the
   * lock, writing heartbeats and unable to do its work is the state a liveness check is
   * structurally blind to.
   */
  | "worker_degraded"
  /**
   * The API host is serving 5xx above both an absolute floor and a rate, read from
   * `platform_signals`. It cannot be evaluated from inside the API host — a serverless
   * invocation that returns a 502 and dies writes nothing here — so a poller mirrors the
   * platform's own request log into a table and this rule reads that.
   */
  | "api_5xx_rate"
  /**
   * THE HOST EVALUATING THIS RULE is running against a database older than the migration journal
   * it ships with. HOST-LOCAL by construction: each driver asks the question about ITSELF, and
   * the key carries which host answered, because "the worker is ahead of the database" and "the
   * API is ahead of the database" are two different deploys gone wrong and have two different
   * fixes.
   */
  | "schema_behind"
  /**
   * IMAP admission refused a connection more than the threshold times inside the window. A
   * refusal means a mailbox was at its connection cap: at a trickle it is the cap doing its job,
   * and in a burst it is a mailbox nothing can read — an attachment fetch, an add-time probe and
   * a send reconcile all queue behind it.
   */
  | "imap_admission_refused"
  /**
   * The worker's classifier circuit has been open longer than the threshold: every message is
   * being filed rules-only, deployment-wide. Read from `worker_heartbeats.ai_circuit_open_since`,
   * which is the only place the in-process breaker's age is visible.
   */
  | "ai_provider_down"
  /**
   * No completed credit roll-up inside the threshold. The console's whole spend read is served
   * from the aggregates that pass writes, so a dark roll-up does not fail — it serves figures
   * that quietly stop moving, which is worse.
   */
  | "credit_rollup_stale"
  /**
   * ONE OF THE TWO ALERT DRIVERS HAS STOPPED RUNNING, reported by the OTHER one. The pair exists
   * because a driver cannot report its own death; this rule is what makes the pair mean
   * something, and without it both arms could stop and the only evidence would be an absence of
   * pages — indistinguishable from a healthy deployment.
   */
  | "alert_driver_dark"
  /**
   * Refresh-token reuse revoked families on enough DISTINCT accounts inside the window that it
   * stops being one broken client and starts being a population. Escalated from the per-account
   * `session_reuse_revoked` signal, which stays firing underneath.
   */
  | "credential_replay_wide"
  /**
   * A metered model call was PAID FOR (a `credit_ledger` debit) and `ai_usage_daily` has no row
   * for a host that reason localizes to — `aiUsageUnrecorded` in `ai-usage.ts`. Always a SIGNAL:
   * the money still moved and the mail still routed, so nothing is down. What is dark is one
   * column of the cost board — an `onUsage` a composition root forgot to wire, the exact
   * production state that module's own header describes.
   */
  | "ai_usage_unrecorded";

export type AlertSeverity = "critical" | "warning";

/**
 * INCIDENT or SIGNAL — the class that decides DELIVERY, not merely presentation.
 *
 * ## Why severity could not express this
 *
 * `storage_at_cap` and `sync_lag` are both `warning`, and only one of them is a customer being
 * wronged. `session_reuse_revoked` is a warning that describes a defence that ALREADY FIRED. Read
 * off severity alone, an operator woken at 3am cannot tell which of those needs them now, and the
 * difference is not one of degree: the two want different behaviour from the pager.
 *
 * · An **incident** is a real application problem. It goes to the sinks and it wakes somebody.
 * · A **signal** is informational. It is recorded in `alert_state`, it renders on the board, and
 *   it never reaches a sink.
 *
 * ## The direction the default has to fall
 *
 * {@link Alert.cls} is optional and absent means INCIDENT — see {@link alertClass}. A rule whose
 * author forgot the field pages. The other default silently converts a new incident into a row
 * that fires, renders, and reaches no human, which is the exact silence this file exists to
 * refuse; the cost of the safe direction is a noisy page, which is loud and gets fixed.
 */
export type AlertClass = "incident" | "signal";

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
  /**
   * `outbound_sends.status='pending'` older than this is stuck — AND THE SENTENCE THIS ALERT
   * MEANS HAS CHANGED, which is why the number did.
   *
   * It used to mean "a sender died and nothing will ever resolve this row", and ten minutes —
   * `SEND_STALE_AFTER_MS`, the age past which no invocation can still be running — was exactly
   * right for that: the moment a row became unresolvable, a human was the only remedy.
   *
   * A reconciling pass now examines such a row every minute, so the same reading would page on
   * the ordinary case: a row goes stale at ten minutes and is resolved on the next cycle. What
   * is worth waking somebody for is the reconciler NOT DRAINING — and fifteen minutes is that
   * statement with the arithmetic behind it: ten to become eligible, plus five for the
   * once-a-minute clock (its cadence plus jitter, several cycles over) to have had every
   * chance. A row still `pending` then is one the reconciler is deferring or never sees, which
   * is a real fault and the one this rule now names.
   */
  stuckSendMs: number;
  /** An on-duty mailbox not synced within this is lagging. Arch doc: 15 minutes. */
  syncLagMs: number;
  /**
   * The SUSTAIN margin on top of {@link syncLagMs} before a lagging mailbox pages — the
   * debounce a boundary measurement forced. Measured live (2026-08-24): every on-duty
   * mailbox was one to four minutes fresh, yet the alert address kept receiving "1 mailbox
   * behind by more than 15m", because the worker's serialized scan visits mailboxes in lanes
   * and a healthy scan's TAIL routinely kisses the 15-minute threshold itself — the rule was
   * paging on the scheduler's own period. One further full period is the discriminator: a
   * mailbox the next scan picks up drops back to minutes and never pages; a mailbox no scan is
   * advancing keeps aging straight through the margin. Fifteen minutes, i.e. the threshold
   * again, because the tail IS the period.
   */
  syncLagSustainMs: number;
  /**
   * The CRITICAL tier for sync lag: the age at which "their owners are not receiving mail"
   * stops being an overclaim and becomes the plain truth. Two hours is eight healthy scan
   * periods — no scheduler artifact reaches it, and a person checking their inbox notices.
   * Below it the warning tier says what is actually true at that lag: delivery is delayed.
   */
  syncLagCriticalMs: number;
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
   *
   * `session_sync_stale` reads the SAME threshold on purpose — the condition is the same
   * quantity one level down ("a sync client that stopped converging"), and two knobs for one
   * judgment is how a console ends up disagreeing with the pager. It doubles as the
   * still-requesting bound: a session unseen for longer than this is a closed tab, not a
   * wedged install.
   */
  deviceSyncStaleMs: number;
  /**
   * How far back the reuse-revocation rule looks in `auth_events`. 24 hours: long enough that
   * an overnight incident is still on the console in the morning and pages once per repeat
   * interval while fresh, short enough that a handled incident leaves the board by itself.
   */
  reuseRevokedWindowMs: number;
  /**
   * How long a leader may report itself DEGRADED before it is an incident. Ten minutes: a normal
   * boot is degraded (mailboxes attached, nothing cycled yet) and a roster churn is briefly
   * degraded, so the threshold has to be one a healthy worker clears on its own. Measured
   * against the worker's uptime rather than a `degraded_since` column the heartbeat does not
   * carry — see the rule.
   */
  workerDegradedMs: number;
  /**
   * The window the 5xx rate is judged over, and the width the poller's rows are summed across.
   * Fifteen minutes = three five-minute polls, so a single missed poll still leaves two windows
   * of evidence rather than none.
   */
  api5xxWindowMs: number;
  /**
   * The ABSOLUTE floor. Ten errors, because a rate alone pages on nothing: three requests in a
   * quiet minute, one of them a 500, is 33% and is not an incident. Both conditions, never
   * either.
   */
  api5xxMinErrors: number;
  /**
   * The RATE floor, as a fraction. Two percent, because a floor alone pages on a busy deployment
   * having a normal day: ten 500s out of two hundred thousand requests is a bad hour for ten
   * people and not an outage. Both conditions, never either.
   */
  api5xxMinRate: number;
  /**
   * How far back `imap_admission_refused` counts refusals, and how long a refusal counter lives.
   * Fifteen minutes: long enough that a burst is still visible when the pass next runs (the
   * worker's cadence is one minute, the API driver's is longer), short enough that the incident
   * clears by itself once the burst stops.
   */
  imapRefusalWindowMs: number;
  /**
   * Refusals inside the window before it is an incident. Five: one or two are the cap doing
   * exactly its job — two concurrent attachment fetches on one mailbox — while five inside a
   * quarter of an hour is a mailbox nothing can get a connection to.
   */
  imapRefusalThreshold: number;
  /**
   * How long the classifier circuit may stay open before it is an incident. Ten minutes, and
   * the number is read against the breaker's own ceiling: `DEFAULT_MAX_COOLDOWN_MS` is fifteen
   * minutes, so a single trip's cooldown cannot reach this on its own — only a run of trips
   * that keeps re-opening does, which is exactly "the provider is down" rather than "one call
   * failed twice".
   */
  aiCircuitOpenMs: number;
  /**
   * No completed credit roll-up inside this ⇒ the roll-up is dark. Twenty-six hours against a
   * nightly pass plus an hourly one: the nightly is the run that matters (it computes totals,
   * divergence and the prune), and 26 h is one nightly cadence plus two hours of slack, so a
   * pass delayed by a deploy is not a page while a pass that stopped is one within the day.
   */
  creditRollupStaleMs: number;
  /**
   * How long one alert driver may go without recording a pass before the OTHER driver reports
   * it dark. Thirty minutes: the worker's cadence is one minute and the API driver's is its
   * scheduler's, so thirty minutes is many missed passes for either arm and no plausible
   * jitter — while being short enough that a driver that died overnight is named before morning.
   */
  alertDriverDarkMs: number;
  /**
   * Distinct accounts with a reuse revocation inside {@link reuseRevokedWindowMs} before the
   * per-account signals escalate to a `credential_replay_wide` incident. Three: one account is a
   * client bug or one stolen token, and three separate accounts in a day is a pattern that is
   * either an attack or a release that broke rotation for everybody.
   */
  reuseWideAccounts: number;
  /**
   * Accounts at the storage cap before the signal escalates to an incident. Five: the rolling
   * window should trim an account before it ever reaches the cap, so one or two are the trim
   * lagging, and five at once is the evict pass not running.
   */
  storageCapWideAccounts: number;
  /**
   * Accounts with a lagging mailbox before the `sync_lag` warning is promoted from a signal to
   * an incident, and the fraction of the on-duty population that does the same. Three accounts,
   * or a fifth of everybody: the first catches a small deployment where three is most of it,
   * the second catches a large one where three is noise and 20% is an outage.
   */
  syncLagWideAccounts: number;
  syncLagWideFraction: number;
}

export const DEFAULT_ALERT_THRESHOLDS: AlertThresholds = {
  leaderStaleMs: 2 * 60 * 1000,
  stuckSendMs: 15 * 60 * 1000,
  syncLagMs: 15 * 60 * 1000,
  syncLagSustainMs: 15 * 60 * 1000,
  syncLagCriticalMs: 2 * 60 * 60 * 1000,
  reconcileStaleMs: 6 * 60 * 60 * 1000,
  deviceSyncStaleMs: 3 * 24 * 60 * 60 * 1000,
  reuseRevokedWindowMs: 24 * 60 * 60 * 1000,
  workerDegradedMs: 10 * 60 * 1000,
  api5xxWindowMs: 15 * 60 * 1000,
  api5xxMinErrors: 10,
  api5xxMinRate: 0.02,
  imapRefusalWindowMs: 15 * 60 * 1000,
  imapRefusalThreshold: 5,
  aiCircuitOpenMs: 10 * 60 * 1000,
  creditRollupStaleMs: 26 * 60 * 60 * 1000,
  alertDriverDarkMs: 30 * 60 * 1000,
  reuseWideAccounts: 3,
  storageCapWideAccounts: 5,
  syncLagWideAccounts: 3,
  syncLagWideFraction: 0.2,
};

/**
 * How long a firing CRITICAL alert waits before it pages again.
 *
 * Not zero (that is the alert address people learn to filter) and not infinite (a fault
 * nobody fixed must resurface). One hour: long enough that a night of a broken worker is six
 * mails and not three hundred, short enough that an alert seen and forgotten comes back
 * before the customer notices.
 *
 * CRITICAL only, since the renotify policy below split the tiers: a standing critical is a
 * production outage and the hourly nag is deliberate; everything else holds for
 * {@link DEFAULT_ALERT_RENOTIFY_UNCHANGED_MS} while UNCHANGED and re-pages at once on a state
 * change (see {@link Alert.signature}).
 */
export const DEFAULT_ALERT_REPEAT_MS = 60 * 60 * 1000;

/**
 * How long an UNCHANGED standing non-critical alert waits before it pages again.
 *
 * The measured failure this exists for: a true `device_sync_stale` warning for one dead
 * pairing was emailed on every repeat interval for fifteen days, and the only thing that
 * changed between the mails was the age in the sentence. A warning is by its own definition
 * ("mail is safe, one install broke") not a page that earns hourly repetition — once, then a
 * daily reminder while it stands, is the whole of what it owes. Any REAL movement in the
 * condition (count, severity — the {@link Alert.signature}) re-pages immediately, so holding
 * the unchanged case costs no latency on the case that matters.
 */
export const DEFAULT_ALERT_RENOTIFY_UNCHANGED_MS = 24 * 60 * 60 * 1000;

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
  /**
   * The CONDITION SIGNATURE — what has to differ for a standing alert to count as CHANGED and
   * re-page ahead of the unchanged-renotify interval. Optional; absent, the pass derives
   * `"<severity>|<count>"`, which is the honest default: severity and the affected count are
   * state, while `oldestSeconds` and the ages interpolated into `title`/`detail` grow on every
   * evaluation and are exactly what a signature must NOT include (an ever-growing age re-paging
   * a warning each pass is the measured failure the renotify policy exists for). A rule whose
   * state has more dimensions than that names them here itself.
   */
  signature?: string;
  /**
   * INCIDENT (pages) or SIGNAL (recorded and rendered only). Optional; absent reads as
   * `"incident"` — see {@link AlertClass} for why the default falls that way.
   */
  cls?: AlertClass;
  /**
   * How many ACCOUNTS this condition affects, or `null`/absent when the rule does not measure a
   * population.
   *
   * DELIBERATELY NOT `count`. The two answer different questions and the rules where they differ
   * are the ones an operator most needs sized: `sync_lag` counts MAILBOXES, and forty lagging
   * mailboxes belonging to one account is a different incident from forty belonging to forty.
   * `null` is not 0 — "this rule is one deployment-wide fact" (a dead worker) must stay
   * distinguishable from "this rule counted accounts and found none".
   */
  affectedAccounts?: number | null;
  /**
   * The INTERNAL CONSOLE PATH an operator should open to act on this — `/worker`, `/billing`,
   * `/accounts/<uuid>`. Rendered as a link; never fetched server-side. A literal with, at most,
   * an id interpolated into it: nothing here is derived from what any message says.
   */
  fixHref?: string | null;
}

/** The effective signature of a firing alert — {@link Alert.signature}'s documented default. */
export function alertSignature(a: Alert): string {
  return a.signature ?? `${a.severity}|${a.count}`;
}

/**
 * The effective CLASS of a firing alert — {@link Alert.cls}'s documented default.
 *
 * The default is `"incident"` and the direction is the whole point: a rule that forgets to
 * classify itself pages, rather than becoming a row that fires and reaches nobody. Every caller
 * that decides delivery goes through this function rather than reading `a.cls` directly, so
 * there is exactly one place the default lives.
 */
export function alertClass(a: Alert): AlertClass {
  return a.cls ?? "incident";
}

/** Everything that pages, in the order the rules produced it. */
export function incidentsOf(alerts: readonly Alert[]): Alert[] {
  return alerts.filter((a) => alertClass(a) === "incident");
}

/** Everything that is recorded and rendered but never delivered. */
export function signalsOf(alerts: readonly Alert[]): Alert[] {
  return alerts.filter((a) => alertClass(a) === "signal");
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
  /**
   * WHICH DRIVER IS ASKING. The worker's in-process timer is `"worker"`; the API host's cron
   * route is `"api"`.
   *
   * Two rules need it and neither can be written without it. `alert_driver_dark` looks at the
   * OTHER driver's row, because a process cannot testify to its own death — the same sentence
   * `worker_down` is built on, one level up. `schema_behind` names the host in its key, because
   * "the worker is ahead of the database" and "the API is ahead of the database" are two
   * different deploys gone wrong.
   *
   * OPTIONAL, and both rules are simply not evaluated when it is absent. A one-shot caller — a
   * test, a runbook `curl`, the console rendering what the pager would say — is not a driver, and
   * a pass that claimed to be one would either resolve a live driver's row or page about a
   * scheduler that is running perfectly.
   */
  driver?: AlertDriver;
}

/**
 * The two arms of the alerting, as a closed set — `alert_pass_runs`'s primary key.
 *
 * The worker runs the pass every minute in-process; the API host runs the same pass from a route
 * an off-platform scheduler pokes. The pair exists because one of the CONDITIONS is about the
 * worker itself, and it stays a pair because each one is the only observer of the other's death.
 */
export type AlertDriver = "worker" | "api";

/**
 * The kinds only ONE ARM of the alerting evaluates, and therefore the only kinds a pass may not
 * resolve merely because they are absent from its own firing set.
 *
 * Two shapes, one property. `worker_down`, `worker_degraded` and `ai_provider_down` are keyed by
 * SHARD and evaluated only for the shards a pass was given — the worker passes none, because all
 * three are statements about the worker. `schema_behind` and `alert_driver_dark` are keyed by
 * DRIVER: each arm evaluates its own journal and the other arm's pulse, so for either key exactly
 * one arm has an opinion.
 *
 * Every other kind is a fact about the deployment that both arms read out of the same database,
 * so absence from a firing set genuinely means the condition cleared and the row should go.
 *
 * A new rule that either arm can decline MUST be added here. The cross-driver test in
 * `alerts-reliability.test.ts` is what makes that a failure rather than a silent flap.
 */
export const SCOPED_ALERT_KINDS: ReadonlySet<string> = new Set<AlertKind>([
  "worker_down", "worker_degraded", "ai_provider_down", "schema_behind", "alert_driver_dark",
  // `imap_admission_refused` is scoped by ROLE rather than by shard or driver name, and it is
  // the one that had to be measured rather than reasoned about: the counter lives in
  // `auth_throttle`, which `ohmail_admin` deliberately does NOT hold — that table is on the
  // blind role's excluded list on purpose. So the API arm's read raises 42501, the rule swallows
  // it and emits no key, and before this entry the API pass then DELETED the worker's row on
  // every pass. Same flap as the four above, arriving through a grant rather than a signature.
  "imap_admission_refused",
]);

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
/**
 * The column whose ABSENCE means this database is older than the bundle this host ships.
 *
 * THE **LAST** STATEMENT'S COLUMN, and the distinction is the whole correctness of this check.
 *
 * The first cut used `alert_state.cls` — the migration's FIRST additive statement — on the
 * argument that the pass writes it on every observation. That argument is true and insufficient:
 * statements inside a migration apply in order, so `cls` being present says nothing about the two
 * TABLES and the heartbeat columns that come after it. A database interrupted part-way, or one
 * whose operator ran statements by hand, satisfied the preflight and then threw 42703 or 42P01 on
 * the very next read — the pass dying before it could deliver the finding that explains why,
 * which is the exact failure the preflight was introduced to remove.
 *
 * `alert_pass_runs.sinks_configured` is the migration's LAST statement, so its presence implies
 * every object above it. `health-cloud.ts` reaches the same conclusion for the same reason where
 * it picks its final marker; this is that sentence applied one file over, where it was missed.
 *
 * ── AND THE MARKER MOVES WHEN THE MIGRATION GROWS, WHICH IS THE EASY HALF TO FORGET ──────
 *
 * This pointed at `worker_heartbeats.degraded_since` until a later statement was APPENDED after
 * it. That silently broke the only property the choice rests on: the blind role could see
 * `degraded_since` and not the newly-appended column, so this preflight reported ready and the
 * overview then failed selecting a column it had just declared readable — and a migration
 * interrupted between the two passed both this check and the matching `/health` marker. Adding a
 * statement to 0030 means moving this constant and that marker together, every time.
 */
const SCHEMA_BEHIND_MARKER = { table: "alert_pass_runs", column: "sinks_configured" } as const;

/**
 * IS THIS DATABASE OLDER THAN THE BUNDLE WE ARE RUNNING? — the alert pass's preflight.
 *
 * ── WHY `information_schema` AND NOT THE MIGRATOR'S TABLE ─────────────────────────────────
 *
 * The first cut compared `max(created_at)` in `drizzle_cloud.__drizzle_migrations` against the
 * journal head this bundle ships. It could never fire in production, and the reason is a grant:
 * `harden-staff-role.sql` revokes everything and grants back `public` and `admin` ONLY, and the
 * runtime role has `public` alone — so NEITHER driver holds USAGE on the migrator's schema. Both
 * raised 42501, the rule's own catch swallowed it as "a handle without USAGE costs exactly this
 * rule", and the rule was decoration on every hardened deployment. Widening a deliberately narrow
 * role to fix an observability read would have been the wrong trade.
 *
 * `information_schema.columns` needs no grant: it is readable by everyone and shows each role the
 * objects it already has privileges on. Both drivers hold grants on `alert_state`, so both can
 * see whether its marker column exists — which is the same mechanism `health-cloud.ts` already
 * uses to answer `503 schema_incomplete`, now reused rather than reinvented.
 *
 * ── AND WHY IT IS A PREFLIGHT ─────────────────────────────────────────────────────────────
 *
 * Every other rule reads columns this bundle's migration adds. Against an older database those
 * SELECTs raise 42703 and take the whole pass down before any rule can say why — so the one
 * finding that explains the outage was structurally the one finding that could not be produced.
 * This runs first, on `information_schema` alone, and when it fires the caller stops: there is
 * nothing else this bundle can honestly read from a database it does not match.
 */
export async function alertSchemaReadable(db: Tx): Promise<boolean> {
  const raw = await db.execute(
    sql`select count(*)::int as n from information_schema.columns
        where table_schema = 'public'
          and table_name = ${SCHEMA_BEHIND_MARKER.table}
          and column_name = ${SCHEMA_BEHIND_MARKER.column}`,
  ) as unknown;
  const rows = (Array.isArray(raw) ? raw : (raw as { rows?: unknown })?.rows ?? []) as
    Array<{ n: number | string }>;
  return Number(rows[0]?.n ?? 0) > 0;
}

async function schemaBehindAlert(db: Tx, opts: EvaluateOptions): Promise<Alert | null> {
  if (!opts.driver) return null;
  const raw = await db.execute(
    sql`select count(*)::int as n from information_schema.columns
        where table_schema = 'public'
          and table_name = ${SCHEMA_BEHIND_MARKER.table}
          and column_name = ${SCHEMA_BEHIND_MARKER.column}`,
  ) as unknown;
  // BOTH RESULT SHAPES: `postgres.js` returns the rows AS the array, PGlite returns `{ rows }`.
  // Destructuring the object form throws "is not iterable", which would take down the very pass
  // this preflight exists to keep alive. Measured once already on this file's other raw query.
  const rows = (Array.isArray(raw) ? raw : (raw as { rows?: unknown })?.rows ?? []) as
    Array<{ n: number | string }>;
  const present = Number(rows[0]?.n ?? 0) > 0;
  if (present) return null;
  return {
    key: `schema_behind:${opts.driver}`,
    kind: "schema_behind",
    severity: "critical",
    title: `The ${opts.driver} host is ahead of the database schema`,
    detail:
      `This ${opts.driver} deployment expects \`${SCHEMA_BEHIND_MARKER.table}.` +
      `${SCHEMA_BEHIND_MARKER.column}\` and the database does not have it, so this host is ` +
      `running against a schema older than the bundle it ships. Code that reads a column this ` +
      `database does not have fails — loudly on a request path, and SILENTLY on any pass that ` +
      `swallows its own errors, including this one. No other alert rule can be evaluated until ` +
      `this is fixed. Run the cloud migrations, then re-run scripts/harden-staff-role.sql for ` +
      `any grant the new migration widened.`,
    count: 1,
    oldestSeconds: null,
    cls: "incident",
    affectedAccounts: null,
    fixHref: "/reliability",
    signature: `behind|${SCHEMA_BEHIND_MARKER.table}.${SCHEMA_BEHIND_MARKER.column}`,
  };
}

/**
 * True when this pass found the database older than the bundle — i.e. the preflight fired and
 * nothing else could be read. {@link runAlertPass} uses it to DELIVER without persisting, because
 * `alert_state` is precisely one of the tables the older schema lacks columns for.
 */
export function isSchemaBehind(alerts: readonly Alert[]): boolean {
  return alerts.length === 1 && alerts[0]!.kind === "schema_behind";
}

export async function evaluateAlerts(db: Tx, opts: EvaluateOptions = {}): Promise<Alert[]> {
  const now = opts.now ?? new Date();
  const t: AlertThresholds = { ...DEFAULT_ALERT_THRESHOLDS, ...opts.thresholds };
  const shards = opts.shards ?? [0];
  const alerts: Alert[] = [];

  // ── PREFLIGHT, BEFORE ANY READ THAT THIS BUNDLE'S MIGRATION MADE POSSIBLE ─────────────
  //
  // If the database is older than this bundle, every rule below raises 42703 on a column that
  // does not exist yet, and the pass dies without saying why. Answer that one question first,
  // out of `information_schema`, and return it ALONE — there is nothing else worth reading.
  const behind = await schemaBehindAlert(db, opts);
  if (behind) return [behind];

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
      // Rules 1b and 10's columns. Every one is a count, a flag or a timestamp the worker
      // computes about itself, and every one is on the staff allowlist by name — this select is
      // run by the API driver over the blind role, so a column that is not granted is 42501 on
      // the whole pass, not on one rule.
      degraded: workerHeartbeats.degraded,
      mailboxes: workerHeartbeats.mailboxes,
      expected: workerHeartbeats.expected,
      quarantined: workerHeartbeats.quarantined,
      lastCycleAt: workerHeartbeats.lastCycleAt,
      startedAt: workerHeartbeats.startedAt,
      aiCircuitOpenSince: workerHeartbeats.aiCircuitOpenSince,
      degradedSince: workerHeartbeats.degradedSince,
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
      // The archetypal incident: nothing is syncing for anybody.
      cls: "incident",
      // `null`, not a count — a dead worker is ONE deployment-wide fact. Every account is
      // affected, so a number here would either be the whole roster (a scan this rule refuses to
      // do while the deployment is on fire) or a misleading `1`.
      affectedAccounts: null,
      fixHref: "/worker",
    });
  }

  // ── 1b. the leader is ALIVE and reporting itself DEGRADED ─────────────────────────────
  //
  // The fault a liveness check is structurally blind to. `worker_heartbeats.degraded` is derived
  // from NAMED causes in the worker (`DegradedCauses`), so it can never be true without a reason
  // the `/health` surface also names — and a leader that holds the lock, writes fresh beats and
  // cannot do its work looks perfectly healthy to rule 1, which reads `leader` and `beat_at` and
  // nothing else.
  //
  // SUSTAINED, not instantaneous: `degraded` is true for a normal boot (mailboxes attached,
  // nothing cycled yet) and briefly whenever the roster churns, so the honest threshold is one
  // that a booting worker clears and a stuck one does not. Ten minutes is several roster passes.
  //
  // ── MEASURED FROM `degraded_since`, WHICH IS A DURATION AND NOT AN UPTIME ─────────────
  //
  // This rule used to read `started_at` and ask "has the process been up longer than the
  // threshold AND is it degraded right now". That suppresses a BOOT, which is what it was
  // written for, and suppresses nothing afterwards: a leader up for a day that flipped
  // `degraded` for a single beat — one roster churn, one mailbox re-attaching — satisfied both
  // halves and paged as a CRITICAL. A pager that fires on routine churn is one an operator
  // learns to skim, which is the failure this file's incident/signal split exists to prevent,
  // arriving through the one rule whose threshold read as if it already prevented it.
  //
  // `degraded_since` (cloud 0030) is the durable clock that makes the real question answerable:
  // when this worker FIRST reported itself degraded in the current unbroken run, cleared to NULL
  // by the first healthy beat. THE BOOT SUPPRESSION FALLS OUT OF IT rather than being a second
  // condition — a worker that has just started and is briefly degraded has a stamp seconds old,
  // and one that has churned and recovered has no stamp at all.
  //
  // It lives on the ROW, not in the worker's memory, and that is the load-bearing choice: the
  // incoming leader after a deploy finds the previous one's stamp and keeps it, so a fault that
  // outlives the process which first saw it keeps its true age. An in-process clock would
  // restart on every handover, and a ten-minute rule would then never fire on a deployment that
  // restarts more often than that.
  //
  // NULL is both "healthy" and "wrote no beat under a build that stamps this", and neither may
  // page — the same reading `ai_circuit_open_since` takes one rule down.
  for (const shard of shards) {
    const beat = bySh.get(shard);
    if (!beat || !beat.leader || !beat.degraded) continue;
    const beatAgeSeconds = secondsBetween(now, beat.beatAt);
    // A stale beat is rule 1's subject, not this one's — reporting both about one shard would
    // page twice for one worker.
    if ((beatAgeSeconds ?? Infinity) * 1000 > t.leaderStaleMs) continue;
    if (!beat.degradedSince) continue;
    const degradedSeconds = secondsBetween(now, new Date(beat.degradedSince as unknown as string));
    if ((degradedSeconds ?? 0) * 1000 <= t.workerDegradedMs) continue;
    const upSeconds = secondsBetween(now, beat.startedAt);
    alerts.push({
      key: `worker_degraded:${shard}`,
      kind: "worker_degraded",
      severity: "critical",
      title: `Sync worker (shard ${shard}) is running but degraded`,
      detail:
        `The leader for shard ${shard} (${beat.instanceId}) is beating normally ` +
        `(${humanAge(beatAgeSeconds)} ago) and has been reporting itself DEGRADED for ` +
        `${humanAge(degradedSeconds)} — past the ` +
        `${humanAge(Math.round(t.workerDegradedMs / 1000))} allowance that lets a boot and a ` +
        `roster churn settle. It has been up for ${humanAge(upSeconds)}, and holds ` +
        `${beat.mailboxes} of ${beat.expected} expected mailbox(es), ` +
        `${beat.quarantined} quarantined, and its last successful cycle was ` +
        `${humanAge(secondsBetween(now, beat.lastCycleAt))} ago. A liveness check cannot see ` +
        `this: the process is alive and the work is not happening. The worker's /health names ` +
        `the cause.`,
      count: 1,
      // The condition's state, named rather than defaulted: the default signature is
      // `severity|count` and this rule's count is always 1, so an unchanging signature would
      // hold the page for the whole unchanged interval however far the roster drifted. The
      // three numbers here are what an operator would notice changing.
      signature: `degraded|${beat.mailboxes}/${beat.expected}|${beat.quarantined}`,
      // THE AGE OF THE CONDITION, not of the process — they are different numbers and this
      // field is the one an operator reads as "how long has this been broken".
      oldestSeconds: degradedSeconds,
      cls: "incident",
      affectedAccounts: null,
      fixHref: "/worker",
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
      cls: "incident",
      // The COUNT is of events, not accounts, and this rule does not read the account column —
      // several failures routinely belong to one customer's retry storm, so reporting the event
      // count as an account count would overstate the blast radius of exactly the incident an
      // operator is trying to size.
      affectedAccounts: null,
      fixHref: "/billing",
    });
  }

  // ── 3. outbound_sends pending > threshold ─────────────────────────────────────────────
  //
  // `pending` is a RESERVATION, not a delivery: the row is written before SMTP is touched, so
  // one older than the threshold means the process that reserved it died mid-flight. Never
  // auto-resent (the resolver checks Sent first) — which is precisely why a human has to be
  // told the queue is not draining.
  //
  // WHAT THIS RULE NOW MEANS is "the RECONCILER is not draining", not "a sender died": a
  // reconciling pass examines every stale reservation once a minute, so a row that reaches this
  // threshold has survived several of its cycles. See {@link AlertThresholds.stuckSendMs} for
  // the arithmetic behind the number.
  const stuckBefore = new Date(now.getTime() - t.stuckSendMs);
  const stuck = await db
    .select({
      count: sql<number>`count(*)::int`,
      // The blast radius, counted in the same aggregate rather than a second query: a queue of
      // forty stuck sends belonging to one account is a broken mailbox, and forty belonging to
      // forty is a broken sender. `account_id` is on the staff allowlist for this table.
      accounts: sql<number>`count(distinct ${outboundSends.accountId})::int`,
      oldest: sql<Date | null>`min(${outboundSends.createdAt})`,
    })
    .from(outboundSends)
    .where(and(eq(outboundSends.status, "pending"), lt(outboundSends.createdAt, stuckBefore)));
  const stuckCount = Number(stuck[0]?.count ?? 0);
  const stuckAccounts = Number(stuck[0]?.accounts ?? 0);
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
        `The reconciling pass has had several cycles at these and has not resolved them. ` +
        `The user believes these were sent. They are never auto-resent.`,
      count: stuckCount,
      oldestSeconds,
      cls: "incident",
      affectedAccounts: stuckAccounts,
      fixHref: "/actions",
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
  //
  // THE CUT IS THRESHOLD + SUSTAIN, not the threshold alone — the debounce. The evaluator is a
  // pure read with no memory, so "lagging on two consecutive passes" is expressed as age: a
  // healthy serialized scan's tail reaches `syncLagMs` itself (measured — see the threshold's
  // doc), so a mailbox only counts once it has aged through one FULL further period without any
  // scan advancing it. A mailbox at 15m30s that the next scan returns to minutes never appears
  // here; a wedged one crosses this cut one period later and stays.
  const lagBefore = new Date(now.getTime() - (t.syncLagMs + t.syncLagSustainMs));
  const criticalBefore = new Date(now.getTime() - t.syncLagCriticalMs);
  const laggingByAccount = await db
    .select({
      accountId: mailboxes.accountId,
      count: sql<number>`count(*)::int`,
      // The CRITICAL-tier members of the same population — counted per mailbox, not derived
      // from the group's oldest, so the copy can say how many owners are genuinely cut off
      // instead of ascribing the worst mailbox's state to all of them.
      criticalCount: sql<number>`count(*) filter (where coalesce(${mailboxes.lastSyncAt}, ${mailboxes.createdAt}) < ${criticalBefore.toISOString()}::timestamptz)::int`,
      oldest: sql<Date | null>`min(coalesce(${mailboxes.lastSyncAt}, ${mailboxes.createdAt}))`,
      // The warning tier's own oldest — the members NOT past the critical cut — so each row
      // below reports the age of its own population rather than borrowing the other's.
      oldestWarning: sql<Date | null>`min(coalesce(${mailboxes.lastSyncAt}, ${mailboxes.createdAt})) filter (where coalesce(${mailboxes.lastSyncAt}, ${mailboxes.createdAt}) >= ${criticalBefore.toISOString()}::timestamptz)`,
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

  // THE TIER IS THE IDENTITY, because the sentence is a claim (claims are contracts) and the
  // page schedule follows the key. "Their owners are not receiving mail" was the copy at EVERY
  // lag; at thirty minutes it is an overclaim — delivery is delayed, not dead. Two ROWS now,
  // each counting its own mailboxes (a review caught the grouped version re-smuggling the
  // overclaim: one 3-hour mailbox beside a 35-minute one made the sentence cover both):
  //
  //  · `sync_lag` — the SUSTAINED-warning tier. A throttling provider or a slow scan tail
  //    produces this and resolves itself; it becomes urgent by co-occurring with `worker_down`,
  //    which is the alert a human should read first.
  //  · `sync_lag:critical` — mailboxes past `syncLagCriticalMs`, where the strong sentence is
  //    the plain truth. A SEPARATE KEY deliberately, not a severity flip on one key: crossing
  //    the tier creates a NEW `alert_state` row, whose NULL `notified_at` the claim machinery
  //    pages immediately, retries after a failed delivery, and survives a crash between passes
  //    — the properties a same-key escalation was twice shown to lose (first to the
  //    repeat schedule, then to the failed-delivery restore path putting the warning's stamp
  //    under a row already marked critical). Key splits ship to BOTH alert drivers in one
  //    deploy window — the version-skew rule written out at the reconciliation rule's key.
  const effectiveMs = t.syncLagMs + t.syncLagSustainMs;
  const criticalCount = onDuty.reduce((n, r) => n + Number(r.criticalCount), 0);
  const warningCount = lagCount - criticalCount;
  const parkedSuffix = parkedCount > 0
    // The exclusion is STATED, not silent. An operator who knows five mailboxes are stale
    // and reads "3" must be able to see where the other two went without reading this file.
    ? ` (${parkedCount} further stale mailbox(es) are parked by their subscription's ` +
      `entitlement and are deliberately not synced — not counted.)`
    : "";
  const minDate = (ds: Array<Date | null>): Date | null =>
    ds.reduce<Date | null>((min, d) => (d && (!min || d < min) ? d : min), null);

  // ── THE PROMOTION: how many ACCOUNTS, as a share of how many there are ─────────────────
  //
  // The warning tier is a SIGNAL by default, and that is a real change of posture: a handful of
  // mailboxes past the sustain cut is a throttling provider or a slow scan tail, it resolves
  // itself, and it was paging a human every time. What makes it an incident is POPULATION — the
  // same lag reaching enough customers that the cause is ours rather than a provider's.
  //
  // TWO ARMS because one number cannot serve both sizes of deployment. Three accounts is most of
  // a small one and noise on a large one; a fifth of everybody is an outage on a large one and
  // is reached by a single account on a deployment with four. Either arm promotes.
  //
  // THE DENOMINATOR IS THE ON-DUTY ACCOUNT COUNT, read as a count and never as a roster — the
  // whole rule is built to stay bounded while every mailbox in the deployment is lagging, and a
  // scan of the accounts table at that moment is exactly the wrong thing to add. Accounts the
  // entitlement has PARKED are excluded from both sides: they are not supposed to be syncing, so
  // counting them in the denominator would make a real outage look like a smaller share of a
  // larger population.
  // COUNTED OVER THE WARNING TIER'S OWN ACCOUNTS, which is not `onDuty.length`.
  //
  // `onDuty` is every account with ANY lagging mailbox, critical ones included, and using it
  // here promoted the WARNING row on a population it does not describe. The case is ordinary:
  // three accounts two hours behind and one account forty minutes behind gives `criticalCount`
  // 3, `warningCount` 1 and `onDuty.length` 4 — so the warning row crossed the three-account arm
  // and PAGED, claiming "4 of N on-duty account(s) are affected", for a condition that is one
  // mailbox on one account. The three genuinely broken accounts were already paging under
  // `sync_lag:critical`, so the promotion added nothing except a second page with a wrong number
  // in it, and the number is the one an operator sizes the incident from.
  //
  // The critical row has always filtered its own population (`criticalCount > 0`, below); this
  // is the mirror of that, and the two together mean each tier's population describes the
  // mailboxes that tier is actually about.
  const laggingAccounts = onDuty
    .filter((r) => Number(r.count) - Number(r.criticalCount) > 0).length;
  const [dutyRow] = await db
    .select({ n: sql<number>`count(distinct ${mailboxes.accountId})::int` })
    .from(mailboxes)
    .where(ne(mailboxes.status, "disabled"));
  const dutyAccountsRaw = Number(dutyRow?.n ?? 0);
  // The parked set is only known for the LAGGING accounts (that is what was asked about), so the
  // denominator can only be corrected by the parked accounts we actually measured. That
  // under-corrects — parked accounts that are not lagging stay in the denominator — which makes
  // the computed share SMALLER than the truth and the promotion HARDER, never easier. The safe
  // direction for a rule whose promotion wakes somebody.
  const dutyAccounts = Math.max(1, dutyAccountsRaw - parked.size);
  const lagShare = laggingAccounts / dutyAccounts;
  const lagWide = laggingAccounts >= t.syncLagWideAccounts || lagShare >= t.syncLagWideFraction;

  if (warningCount > 0) {
    const oldestSeconds = secondsBetween(now, minDate(
      onDuty.map((r) => (r.oldestWarning ? new Date(r.oldestWarning as unknown as string) : null)),
    ));
    alerts.push({
      key: "sync_lag",
      kind: "sync_lag",
      severity: "warning",
      title: `${warningCount} mailbox${warningCount === 1 ? "" : "es"} behind by more than ` +
        `${humanAge(Math.round(effectiveMs / 1000))}`,
      detail:
        `${warningCount} mailbox(es) the worker is on duty for have not synced within ` +
        `${humanAge(Math.round(effectiveMs / 1000))}; the worst of them is ` +
        `${humanAge(oldestSeconds)} behind. Mail delivery to them is delayed.` +
        (lagWide
          ? ` ${laggingAccounts} of ${dutyAccounts} on-duty account(s) are affected ` +
            `(${Math.round(lagShare * 100)}%) — past the promotion cut, so this is being treated ` +
            `as an incident rather than an observation.`
          : ` ${laggingAccounts} of ${dutyAccounts} on-duty account(s) are affected ` +
            `(${Math.round(lagShare * 100)}%), below the cut at which a slow scan stops being the ` +
            `likelier explanation.`) + parkedSuffix,
      count: warningCount,
      oldestSeconds,
      // A SIGNAL until the population says otherwise — see the promotion block above.
      cls: lagWide ? "incident" : "signal",
      affectedAccounts: laggingAccounts,
      fixHref: "/worker",
      // The class is part of the state, so it belongs in the signature: without it a lag that
      // spreads from two accounts to twenty at an unchanged mailbox count would flip to an
      // incident and then sit on the signal's own confirmation for the whole unchanged interval,
      // which is the same suppression the tier keys were split to avoid.
      signature: `${lagWide ? "incident" : "signal"}|${warningCount}|${laggingAccounts}`,
    });
  }
  if (criticalCount > 0) {
    const oldestSeconds = secondsBetween(now, minDate(
      onDuty.map((r) => (r.oldest ? new Date(r.oldest as unknown as string) : null)),
    ));
    alerts.push({
      key: "sync_lag:critical",
      kind: "sync_lag",
      severity: "critical",
      title: `${criticalCount} mailbox${criticalCount === 1 ? "" : "es"} behind by more than ` +
        `${humanAge(Math.round(t.syncLagCriticalMs / 1000))}`,
      detail:
        `${criticalCount} mailbox(es) the worker is on duty for have not synced within ` +
        `${humanAge(Math.round(t.syncLagCriticalMs / 1000))}; the worst is ` +
        `${humanAge(oldestSeconds)} behind. ` +
        `${criticalCount === 1 ? "Its owner is" : "Their owners are"} not receiving mail.` +
        parkedSuffix,
      count: criticalCount,
      oldestSeconds,
      // ALWAYS an incident, whatever the population: at two hours the sentence "their owners are
      // not receiving mail" is the plain truth, and it is true of one owner as much as of forty.
      // The promotion above is about the WARNING tier only.
      cls: "incident",
      affectedAccounts: onDuty.filter((r) => Number(r.criticalCount) > 0).length,
      fixHref: "/worker",
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
    // ── THE ESCALATION: one account bumping a ceiling, or a pass that has stopped ─────────
    //
    // The rolling window is supposed to trim an account BEFORE it reaches its cap, so a single
    // at-cap account is the trim lagging behind one unusually heavy mailbox — worth knowing,
    // not worth waking anybody. Five at once is a different claim entirely: the trim is not a
    // per-account behaviour, so five accounts reaching the ceiling together is the evict pass
    // not running, and every one of those customers is having new mail withheld from the
    // hosted store while it stays broken.
    const capWide = atCapOnDuty.length >= t.storageCapWideAccounts;
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
          : "") +
        (capWide
          ? ` ${atCapOnDuty.length} accounts reaching the ceiling together is not a per-account ` +
            `pattern: THE EVICT PASS IS BROKEN. Check worker storage_evict_pass.`
          : ""),
      count: atCapOnDuty.length,
      oldestSeconds: null,
      // A signal at one or two accounts; an incident once the count says the pass itself stopped.
      cls: capWide ? "incident" : "signal",
      affectedAccounts: atCapOnDuty.length,
      fixHref: capWide ? "/worker" : "/accounts",
      // The class joins the signature for `sync_lag`'s reason: the default is `severity|count`,
      // severity never moves on this rule, and a count that crosses the cut must re-page rather
      // than inherit the signal's confirmation.
      signature: `${capWide ? "incident" : "signal"}|${atCapOnDuty.length}`,
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
  //
  // ── AND THE MODE FILTER IS NOT COSMETIC (cloud 0029) ──────────────────────────────────
  //
  // "Either mode" means either SUBSCRIPTION mode. Since 0029 the same run ledger also carries
  // `mode = 'invoices'` rows from the invoice mirror's daily heal, and those must be invisible
  // here for a reason this rule already knows in its other half: it reads the NEWEST row, so an
  // invoice pass — which runs on its own clock and converges on its own schedule — would become
  // the newest row and this rule would report ITS verdict about a different table as the
  // subscription mirror's. A converged invoice pass would silently resolve a live subscription
  // divergence, every night; a flagged invoice would page as a subscription problem.
  //
  // The invoice pass's own divergences are recorded and counted on its rows; a rule for them is
  // the reliability lane's, and it must be written against `mode = 'invoices'` for the mirror
  // image of this reason.
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
    .where(sql`${billingReconciliationRuns.error} is null
      and ${billingReconciliationRuns.mode} in ('dry-run','apply')`)
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
        // THE TIER IS THE IDENTITY, sync_lag's rule exactly (and found by the same review):
        // a same-key severity flip sits on the warning's `notified_at` until the repeat
        // interval, so a money-state alert going critical inside that window stayed muted.
        // The critical tier's own key opens a NEW row whose NULL stamp pages at once; the
        // warning row resolves in the same pass (it leaves the firing set), so the console
        // shows one row per state, never two for one condition.
        //
        // KEY MIGRATIONS HAVE A DEPLOY RULE, stated here because this line is where the next
        // one gets written: the two alert drivers (the worker's timer, the API's cron) deploy
        // independently, and while they run DIFFERENT revisions each pass resolves — deletes —
        // the other's spelling of a firing condition, re-opening it with a NULL stamp: a page
        // per pass until the revisions converge. So a key split ships to BOTH drivers in one
        // deploy window (the runbook's one-milestone rule), ideally while the condition is not
        // firing. The residual is bounded to that window and LOUD (duplicate pages), never a
        // silence — the acceptable direction, but not one to schedule casually.
        key: unhealed > 0
          ? "billing_reconciliation_divergence:unhealed"
          : "billing_reconciliation_divergence",
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
        // BOTH tiers are incidents, including the healed one. The healed tier says a webhook was
        // LOST and the reconciler put it back — the data is fine and the PIPELINE is not, and the
        // next thing it drops may be an invoice nobody notices for a month. That is money state
        // and it wants a person, which is the line between the two classes.
        cls: "incident",
        // The pass records divergent ACCOUNTS nowhere by design (`billing_reconciliation_runs`
        // stores counts and codes, never the rows), so this rule cannot answer the question
        // without a read the isolation ruling refused. `null` says so.
        affectedAccounts: null,
        fixHref: "/billing",
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
        // An incident despite the `warning` severity, and the pair is the argument for why the
        // two axes are separate: nothing is wrong RIGHT NOW (that is the severity), and the net
        // under every money fault has been removed (that is the class).
        cls: "incident",
        affectedAccounts: null,
        fixHref: "/billing",
      });
    }
  }

  // ── 8. a paired native device that stopped syncing ──────────────────────────────────────
  //
  // The population is `devices.last_synced_at` (mail 0064): stamped only by a `GET /sync` poll
  // whose PRESENTED cursor already sits at the horizon — the client's own proof of a committed
  // drain — so "quiet" covers both ways the incident this guards actually happened: a mirror
  // stuck re-paging its backlog forever (requests happening, no convergence) and a session
  // killed by refresh-reuse detection (no requests at all). The client cannot report either:
  // it retries on its own backoff and shows what it holds.
  //
  // EVERY READ HERE IS A NAMED COLUMN ON THE STAFF ALLOWLIST — ids, kinds and timestamps
  // (`staff-grants.ts`: devices id/account_id/kind/last_synced_at, sessions device_id/
  // revoked_at), never a whole row and never a token column. This rule's first form was a
  // SECURITY DEFINER carrier, and the staff attestation refused it by construction (a secdef
  // the blind role can execute is a hole through every column grant): the pager went dark
  // BECAUSE an alarm was added to it. Mail 0068 retired that function; the widened column
  // allowlist is the designed mechanism.
  //
  // THE "MOVED ON" GATE reads `mailboxes.last_sync_at` — the account has a mailbox the worker
  // synced after the device's horizon, so there demonstrably was server-side motion the device
  // never pulled. (`change_log` would be the sharper gate and is deliberately not readable by
  // this role — row existence there is itself information. A mailbox that syncs and truly
  // receives nothing for days keeps this rule armed; that is the acceptable direction.)
  //
  // THE ISOLATION IS PART OF THE RULE: a deployment whose provisioner has not yet granted the
  // two new tables must cost exactly this rule, never the pass — the pass dying wholesale is
  // the failure mode this paragraph exists to record. Only insufficient_privilege is
  // swallowed; anything else is a real fault and still fails the pass loudly.
  //
  // Per-device keys, like `worker_down:<shard>`: paired native devices are tens fleet-wide,
  // the remedy is per-device, and a grouped count would hide WHICH mirror is dead.
  const deviceStaleCut = new Date(now.getTime() - t.deviceSyncStaleMs);
  const deviceArmCut = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
  try {
    const staleDevices = await db
      .select({
        id: devices.id,
        accountId: devices.accountId,
        kind: devices.kind,
        lastSyncedAt: devices.lastSyncedAt,
      })
      .from(devices)
      .where(and(
        ne(devices.kind, "web"),
        isNotNull(devices.lastSyncedAt),
        lt(devices.lastSyncedAt, deviceStaleCut),
      ));
    for (const d of staleDevices) {
      if (d.lastSyncedAt == null) continue; // isNotNull above; narrows the type
      const movedOn = await db
        .select({ id: mailboxes.id })
        .from(mailboxes)
        .where(and(eq(mailboxes.accountId, d.accountId), gt(mailboxes.lastSyncAt, d.lastSyncedAt)))
        .limit(1);
      if (movedOn.length === 0) continue;
      const armed = await db
        .select({ deviceId: sessions.deviceId })
        .from(sessions)
        .where(and(
          eq(sessions.deviceId, d.id),
          or(isNull(sessions.revokedAt), gt(sessions.revokedAt, deviceArmCut)),
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
        // A SIGNAL. The mail is safe on the account and the webapp still shows it; what broke is
        // ONE device's mirror, and the remedy is a support conversation with its owner rather
        // than a night shift. It stays on the board until it clears, which is what it is owed.
        cls: "signal",
        affectedAccounts: 1,
        fixHref: `/accounts/${d.accountId}`,
      });
    }

    // ── the NEVER-SYNCED arm — the exclusion the first real incident proved wrong ─────────
    //
    // The rule above requires `last_synced_at IS NOT NULL`, on the argument that never-synced
    // asserts nothing. Then the first incident this alert existed for arrived exactly there:
    // every wedged mirror is NULL right up until the first time it converges, so a desktop
    // whose pulls never converged — or that died before 0064 ever stamped it — sat outside
    // the population for ever. Both production device rows in the incident were NULL.
    //
    // So a NULL stamp older than the threshold IS an assertion, measured from the row's own
    // `created_at`: paired that long ago, never once current, account moved on since pairing.
    // The armed gate is deliberately NARROWER than the stamped arm's — a LIVE session that is
    // STILL MAKING REQUESTS (`last_seen_at` inside the same threshold the staleness itself
    // uses; one judgment, not two). Both halves are load-bearing:
    //  · a never-synced device whose session was revoked is a pairing that never worked and
    //    was already taken back (test fixtures are exactly this shape); nobody is reading
    //    stale mail from it, because it never showed mail at all;
    //  · a never-synced device whose session is unrevoked but FROZEN — `last_seen_at` at its
    //    own creation instant, weeks old — is a dead pairing handshake, not a person at a
    //    wedged mailbox. The measured incident: a pairing whose one session was last seen the
    //    millisecond it was minted paged on every interval for fifteen days, and the only true
    //    sentence in the page was the age. `session_sync_stale` next door already carries this
    //    gate for the same reason; the arm inherits it rather than re-arguing it.
    // The stamped arm keeps its wider revoked-within-14-days window because there a WORKING
    // mirror went dark and its person does not know.
    const neverSynced = await db
      .select({
        id: devices.id,
        accountId: devices.accountId,
        kind: devices.kind,
        createdAt: devices.createdAt,
      })
      .from(devices)
      .where(and(
        ne(devices.kind, "web"),
        isNull(devices.lastSyncedAt),
        lt(devices.createdAt, deviceStaleCut),
      ));
    for (const d of neverSynced) {
      const movedOn = await db
        .select({ id: mailboxes.id })
        .from(mailboxes)
        .where(and(eq(mailboxes.accountId, d.accountId), gt(mailboxes.lastSyncAt, d.createdAt)))
        .limit(1);
      if (movedOn.length === 0) continue;
      const armed = await db
        .select({ deviceId: sessions.deviceId })
        .from(sessions)
        .where(and(
          eq(sessions.deviceId, d.id),
          isNull(sessions.revokedAt),
          // STILL MAKING REQUESTS — the gate the header argues. A live-but-frozen session
          // (last seen at its own mint, weeks back) is a dead handshake and fires nothing.
          gt(sessions.lastSeenAt, deviceStaleCut),
        ))
        .limit(1);
      if (armed.length === 0) continue;
      const staleSeconds = secondsBetween(now, d.createdAt);
      alerts.push({
        key: `device_sync_stale:${d.id}`,
        kind: "device_sync_stale",
        severity: "warning",
        title: `A paired ${d.kind} device has NEVER completed a sync (paired ${humanAge(staleSeconds)} ago)`,
        detail:
          `Device ${d.id} (kind ${d.kind}) was paired ${humanAge(staleSeconds)} ago ` +
          `(threshold ${humanAge(Math.round(t.deviceSyncStaleMs / 1000))}) and has never once reached ` +
          `the sync horizon, while its account has changes it never received. Its session is live ` +
          `and still making requests — the mirror has been wedged since pairing, and the person ` +
          `in front of it is looking at an empty or frozen mailbox.`,
        count: 1,
        oldestSeconds: staleSeconds,
        cls: "signal",
        affectedAccounts: 1,
        fixHref: `/accounts/${d.accountId}`,
      });
    }
  } catch (err) {
    const code = (err as { code?: string })?.code ?? (err as { cause?: { code?: string } })?.cause?.code;
    // 42501 insufficient_privilege: a handle the provisioner's grants have not reached yet.
    // Everything else stays fatal — a swallowed real fault is a silenced pager.
    if (code !== "42501") throw err;
  }

  // ── 8b. a DEVICELESS session that stopped converging — the browser-door install ─────────
  //
  // The population `device_sync_stale` cannot see: sessions with `device_id IS NULL` (mail
  // 0061's deliberate shape — the browser-door desktop, a plain web tab) plus sessions whose
  // device row is kind 'web' (a paired phone browser; the device rule excludes that kind on
  // purpose). Read from `sessions.last_synced_at` (mail 0070).
  //
  // THREE GATES, each carrying half the false-positive load:
  //   · a NON-NULL stamp — the session PROVED it is a sync client once. A REST-only caller
  //     (a script, an admin tool) never stamps and can never fire; the cost is that an install
  //     wedged from its very first pull is invisible at this level (documented blind spot —
  //     the device rule's never-synced arm covers NAMED devices there).
  //   · `last_seen_at` inside the threshold — the install is STILL MAKING REQUESTS (rotation,
  //     polls). A closed tab freezes both stamps together and ages out silently; the wedged
  //     incident rotated four times an hour for five days and stays inside for ever.
  //   · the account MOVED ON — same `mailboxes.last_sync_at` evidence as rule 8, same reason
  //     `change_log` is not read (row existence there is information the blind role is
  //     refused).
  //
  // Sessions revoked by reuse detection stop requesting and leave this rule's population at
  // the revocation; rule 9 below is the signal for those, at the moment it happens.
  //
  // Same isolation posture as rule 8: the sessions columns this reads are staff-allowlist
  // entries (`staff-grants.ts`), and a handle the provisioner has not reached yet must cost
  // exactly this rule — only 42501 is swallowed.
  try {
    const staleSessions = await db
      .select({
        id: sessions.id,
        accountId: sessions.accountId,
        lastSyncedAt: sessions.lastSyncedAt,
        deviceKind: devices.kind,
      })
      .from(sessions)
      .leftJoin(devices, eq(sessions.deviceId, devices.id))
      .where(and(
        isNull(sessions.revokedAt),
        eq(sessions.scope, "full"),
        isNotNull(sessions.lastSyncedAt),
        lt(sessions.lastSyncedAt, deviceStaleCut),
        gt(sessions.lastSeenAt, deviceStaleCut),
        or(isNull(sessions.deviceId), eq(devices.kind, "web")),
      ));
    for (const s of staleSessions) {
      if (s.lastSyncedAt == null) continue; // isNotNull above; narrows the type
      const movedOn = await db
        .select({ id: mailboxes.id })
        .from(mailboxes)
        .where(and(eq(mailboxes.accountId, s.accountId), gt(mailboxes.lastSyncAt, s.lastSyncedAt)))
        .limit(1);
      if (movedOn.length === 0) continue;
      const staleSeconds = secondsBetween(now, s.lastSyncedAt);
      const shape = s.deviceKind === "web" ? "paired web device" : "deviceless install";
      alerts.push({
        key: `session_sync_stale:${s.id}`,
        kind: "session_sync_stale",
        // WARNING for rule 8's reason: the mail is safe, one install's mirror is what broke.
        severity: "warning",
        title: `A signed-in ${shape} has not synced in ${humanAge(staleSeconds)}`,
        detail:
          `Session ${s.id} (${shape}) last reached the sync horizon ${humanAge(staleSeconds)} ago ` +
          `(threshold ${humanAge(Math.round(t.deviceSyncStaleMs / 1000))}), is still making requests, ` +
          `and its account has newer changes it never received. The person in front of it is ` +
          `reading stale mail and the client cannot say so.`,
        count: 1,
        oldestSeconds: staleSeconds,
        cls: "signal",
        affectedAccounts: 1,
        fixHref: `/accounts/${s.accountId}`,
      });
    }
  } catch (err) {
    const code = (err as { code?: string })?.code ?? (err as { cause?: { code?: string } })?.cause?.code;
    if (code !== "42501") throw err;
  }

  // ── 9. refresh-token reuse revoked a family — an attack or a broken client, never routine ─
  //
  // `auth_events.event = 'refresh_reuse_revoked'`, written by `rotateRefresh`'s reuse branch
  // in the same transaction as the family sweep. Before that row existed the only record was
  // raw session rows (the Aug-21 incident was reconstructed from exactly those), and the
  // person whose session died was told nothing by anybody.
  //
  // Keyed PER ACCOUNT, not per event: one broken client replaying one stale token can write a
  // burst of rows, and the remedy (look at this account's sessions) is account-shaped. The
  // window makes the rule self-resolving — `alert_state` keeps the incident's history after
  // the key stops firing.
  //
  // Isolation posture: `auth_events` columns are on the staff allowlist (never `device`, which
  // carries a client-chosen user-agent string, and never `ip`); a handle without the grant
  // costs exactly this rule — only 42501 is swallowed.
  try {
    const reuseCut = new Date(now.getTime() - t.reuseRevokedWindowMs);
    const reuseRows = await db
      .select({ accountId: authEvents.accountId, at: authEvents.at })
      .from(authEvents)
      .where(and(eq(authEvents.event, "refresh_reuse_revoked"), gt(authEvents.at, reuseCut)));
    const byAccount = new Map<string, { count: number; oldest: Date }>();
    for (const r of reuseRows) {
      const key = r.accountId ?? "unknown";
      const cur = byAccount.get(key);
      if (!cur) byAccount.set(key, { count: 1, oldest: r.at });
      else {
        cur.count += 1;
        if (r.at < cur.oldest) cur.oldest = r.at;
      }
    }
    for (const [accountId, agg] of byAccount) {
      const oldestSeconds = secondsBetween(now, agg.oldest);
      alerts.push({
        key: `session_reuse_revoked:${accountId}`,
        kind: "session_reuse_revoked",
        // WARNING, not critical: the family is already dead — the defense fired. What needs a
        // human is the QUESTION it leaves behind (stolen token, or a client rotating wrongly).
        severity: "warning",
        // DETECTIONS, deliberately not "families" (a review caught the overstatement): several
        // consumed tokens of ONE family replayed concurrently write one row each, and the
        // family id lives in the un-granted `device` column this handle cannot read — so the
        // honest number this query CAN produce is how many times the detector fired.
        title: `Refresh-token reuse detected ${agg.count === 1 ? "once" : `${agg.count} times`} on one account`,
        detail:
          `Reuse detection fired ${agg.count === 1 ? "once" : `${agg.count} times`} on account ` +
          `${accountId} within the last ${humanAge(Math.round(t.reuseRevokedWindowMs / 1000))}, ` +
          `revoking the presented token's session family each time (several detections can name ` +
          `one family). A consumed refresh token was presented again outside the concurrency ` +
          `grace — either a stolen token was replayed or a client's rotation is broken. The ` +
          `account's auth trail (auth_events) carries the family id on each row.`,
        count: agg.count,
        oldestSeconds,
        // A SIGNAL, and the reason is in the rule's own header: the family is already dead. The
        // defence fired, the token is worthless, and what is left is a QUESTION for daylight —
        // stolen token, or a client rotating wrongly. The escalation below is where it stops
        // being a question about one person.
        cls: "signal",
        affectedAccounts: 1,
        fixHref: accountId === "unknown" ? "/accounts" : `/accounts/${accountId}`,
      });
    }

    // ── 9b. the same detection across a POPULATION — an attack, or a broken release ────────
    //
    // One account replaying tokens is a client bug or one stolen credential, and the per-account
    // signals above say so without waking anybody. Three separate accounts inside the window is
    // a different claim: either somebody is working through stolen tokens, or a release broke
    // rotation for every client that took it. Both need a person now, and neither is visible
    // from any one of the per-account rows.
    //
    // The per-account signals KEEP FIRING underneath. This is an additional row, not a
    // replacement: the board should show both the pattern and its members, and resolving the
    // members individually is how the pattern shrinks back below the cut.
    //
    // DISTINCT ACCOUNTS, never the event count — one client retrying a stale token in a loop
    // writes a burst of rows on ONE account, and counting rows would call that an attack.
    if (byAccount.size >= t.reuseWideAccounts) {
      const total = [...byAccount.values()].reduce((n, a) => n + a.count, 0);
      const oldest = [...byAccount.values()]
        .reduce<Date | null>((min, a) => (!min || a.oldest < min ? a.oldest : min), null);
      alerts.push({
        key: "credential_replay_wide",
        kind: "credential_replay_wide",
        severity: "critical",
        title: `Refresh-token reuse detected on ${byAccount.size} separate accounts`,
        detail:
          `Reuse detection fired ${total} time(s) across ${byAccount.size} DISTINCT account(s) ` +
          `within the last ${humanAge(Math.round(t.reuseRevokedWindowMs / 1000))} (cut: ` +
          `${t.reuseWideAccounts} accounts). One account replaying tokens is a client bug or one ` +
          `stolen credential; this many separate accounts is either credential replay at scale ` +
          `or a client release that broke refresh rotation for everyone who took it. Each ` +
          `account's own detection is listed separately as a signal.`,
        count: byAccount.size,
        oldestSeconds: secondsBetween(now, oldest),
        cls: "incident",
        affectedAccounts: byAccount.size,
        fixHref: "/accounts",
      });
    }
  } catch (err) {
    const code = (err as { code?: string })?.code ?? (err as { cause?: { code?: string } })?.cause?.code;
    if (code !== "42501") throw err;
  }

  // ── 10. the model provider has been unreachable long enough that mail is degraded ───────
  //
  // Read from `worker_heartbeats.ai_circuit_open_since` — the ONLY place the in-process
  // classifier breaker's age is visible from here. The breaker itself is per worker PROCESS
  // (`apps/worker/src/ai-circuit.ts`), and its whole design is that mail keeps flowing with the
  // model withheld, so nothing about this state fails, times out, or writes an error row: the
  // customer's mail arrives, files by rules alone, and looks exactly like mail nobody wrote an
  // AI rule for. That is precisely the shape of fault this file exists to name.
  //
  // FROM THE FIRST OPEN of the current run, not the last: the cooldown doubles per trip and the
  // breaker half-opens between them, so the newest open is always minutes old however long the
  // provider has been down. The column carries the first one and the worker clears it on the
  // first success.
  //
  // Only a LIVE leader's row counts. A stale row's `ai_circuit_open_since` is a fact about a
  // process that is no longer running, and `worker_down` is already the alert for that; reading
  // it here would keep a resolved circuit "open" for as long as the dead row sat in the table.
  for (const shard of shards) {
    const beat = bySh.get(shard);
    if (!beat || !beat.leader || !beat.aiCircuitOpenSince) continue;
    const beatAgeSeconds = secondsBetween(now, beat.beatAt);
    if ((beatAgeSeconds ?? Infinity) * 1000 > t.leaderStaleMs) continue;
    const openSince = new Date(beat.aiCircuitOpenSince as unknown as string);
    const openSeconds = secondsBetween(now, openSince);
    if ((openSeconds ?? 0) * 1000 <= t.aiCircuitOpenMs) continue;
    alerts.push({
      key: `ai_provider_down:${shard}`,
      kind: "ai_provider_down",
      severity: "critical",
      title: `The AI provider has been unavailable for ${humanAge(openSeconds)}`,
      detail:
        `Shard ${shard}'s classifier circuit has been open since ${humanAge(openSeconds)} ago ` +
        `(threshold ${humanAge(Math.round(t.aiCircuitOpenMs / 1000))}), measured from the FIRST ` +
        `trip of the current run rather than the newest. Every message is being filed rules-only ` +
        `and no credit is being spent, so nothing fails and nothing is queued — mail arrives and ` +
        `is simply routed worse. Check the provider's status and the API key.`,
      count: 1,
      cls: "incident",
      // Deployment-wide: one circuit per worker process, shared by every mailbox it serves.
      affectedAccounts: null,
      fixHref: "/worker",
      oldestSeconds: openSeconds,
    });
  }

  // ── 11. the API host is serving 5xx above BOTH floors ──────────────────────────────────
  //
  // Read from `platform_signals`, which a five-minute cron fills from the hosting platform's own
  // request log. It cannot be evaluated from inside the API host: a serverless invocation that
  // returns a 502 and dies writes nothing to this database, and the one surface that knows is the
  // platform's.
  //
  // BOTH FLOORS, never either. A rate alone pages on nothing — three requests in a quiet minute,
  // one of them a 500, is 33% — and a count alone pages on a busy deployment having a normal day.
  // The pair is what makes the rule mean "a meaningful share of real traffic is failing".
  //
  // ── UNCONFIGURED IS NOT ZERO, AND THIS IS THE HALF THAT IS EASY TO GET WRONG ────────────
  //
  // A deployment with no platform token writes NO ROWS. Summing an empty set gives 0 requests and
  // 0 errors, which satisfies neither floor, so the rule does not fire — correct by arithmetic,
  // and correct for the wrong reason. What must never happen is the OTHER direction: a board that
  // renders "0 5xx" for a deployment that has never measured any. The rule refuses to speak at all
  // without rows, the panel reads "5xx: not measured", and `platformSignalWindow` below is the one
  // function both of them go through so the two cannot disagree.
  //
  // ── THE RULE GATES ITSELF ON HAVING BEEN MEASURED, AND THE GATE IS THE DATA ──────────
  //
  // It judges only projects with at least one COMPLETE bucket in the window. Nothing else turns
  // it on: no registration flag, no environment check, nothing a person has to remember to flip
  // once the platform token exists. The first real poll that lands a complete bucket makes the
  // rule live; until then it is silent and the board says "5xx: not measured", which is the
  // truthful state of a deployment with no token AND of one whose poller has never successfully
  // run. Neither of those is a rate of zero and neither may page.
  //
  // SAMPLED BUCKETS ARE EXCLUDED FROM THE SUMS, replacing the argument that used to sit here —
  // that a truncated row is safe because both counts are lower bounds. Both counts are; their
  // RATIO is not, and the rate threshold is a ratio. Twenty errors in a sampled thousand crosses
  // both floors while ninety-nine thousand unseen successes put the true rate two orders of
  // magnitude below it. A lower bound is safe in a numerator and unsafe in a quotient.
  //
  // ── WHICH HALF ACTUALLY ENFORCES THIS, STATED BECAUSE THE TWO LOOK INTERCHANGEABLE ────
  //
  // The enforcing half is the `filter (where not truncated)` inside `platformSignalWindow`:
  // remove it and the sampled bucket's thousand requests re-enter the denominator and the rule
  // pages, which the suite catches. The `completeBuckets` test below is DELIBERATELY REDUNDANT
  // with the `requests <= 0` line beneath it — because the sums are filtered, a project with no
  // complete bucket already sums to zero, so removing this line changes no outcome and no test
  // goes red. It is kept as the statement of INTENT, so that a future change to those sums has
  // to confront the word "measured" rather than silently restoring a rate over sampled data.
  // Recorded plainly rather than dressed up as a second guard: a line nobody can watch fail is
  // not evidence, and claiming otherwise here would be the same overclaim this rule exists to
  // refuse.
  const signalWindow = await platformSignalWindow(db, now, t.api5xxWindowMs);
  for (const w of signalWindow) {
    if (w.completeBuckets <= 0) continue;
    if (w.requests <= 0) continue;
    const rate = w.errors5xx / w.requests;
    if (w.errors5xx < t.api5xxMinErrors || rate < t.api5xxMinRate) continue;
    alerts.push({
      key: `api_5xx_rate:${w.provider}:${w.project}`,
      kind: "api_5xx_rate",
      severity: "critical",
      title: `${w.project} is serving ${(rate * 100).toFixed(1)}% 5xx`,
      detail:
        `${w.errors5xx} of ${w.requests} request(s) to ${w.project} returned 5xx in the last ` +
        `${humanAge(Math.round(t.api5xxWindowMs / 1000))} — past both floors ` +
        `(${t.api5xxMinErrors} errors AND ${(t.api5xxMinRate * 100).toFixed(0)}%). ` +
        (w.sampledBuckets > 0
          ? `${w.sampledBuckets} further bucket(s) in this window were SAMPLED and are excluded ` +
            "from these figures: their counts are lower bounds, and a lower bound cannot be " +
            "divided into a rate. The figures above are from complete buckets only. "
          : "") +
        `Newest platform read ${humanAge(secondsBetween(now, w.fetchedAt))} ago.`,
      count: w.errors5xx,
      oldestSeconds: null,
      cls: "incident",
      // The platform's log store cannot attribute an HTTP request to an account, and this table
      // deliberately holds nothing that would let it.
      affectedAccounts: null,
      fixHref: "/reliability",
      // The rate BUCKETED rather than raw: the default signature is `severity|count`, and the
      // error count moves on every single pass during an outage, so it would re-page every
      // cadence for as long as the incident lasted. A whole percentage point of movement is a
      // real change; the third decimal place is not.
      signature: `5xx|${Math.round(rate * 100)}`,
    });
  }

  // ── 12. (MOVED) the host-vs-database check is a PREFLIGHT — see `schemaBehindAlert` ────
  //
  // It used to sit here, in rule order, and that made it unreachable in exactly the case it
  // exists to report: by the time control arrived, rule 1 had already SELECTED columns this
  // migration adds, so against an older database the pass threw before this line ever ran.
  // A rule that reports "the database is behind" cannot be written to require the newer schema.
  // It now runs before any other read; see the top of this function.

  // ── 13. IMAP admission is refusing connections in bulk ─────────────────────────────────
  //
  // A refusal means a mailbox was at its connection cap. One or two inside a quarter of an hour
  // is the cap doing its job — two concurrent attachment fetches on one mailbox is the designed
  // case — and five is a mailbox nothing can get a connection to, with an attachment fetch, an
  // add-time probe and a send reconcile all queueing behind it.
  //
  // Counted deployment-wide in `auth_throttle` under its own key namespace: the refusals happen
  // on the API host, which is serverless and keeps no in-process state, so there is no heartbeat
  // to hang this on. `imapRefusalsInWindow` reads one indexed row and treats an already-rolled
  // window as 0, so a burst that ended an hour ago does not keep the incident standing.
  try {
    const refusals = await imapRefusalsInWindow(db, now, t.imapRefusalWindowMs);
    if (refusals >= t.imapRefusalThreshold) {
      alerts.push({
        key: "imap_admission_refused",
        kind: "imap_admission_refused",
        severity: "warning",
        title: `IMAP admission refused ${refusals} connection(s) in the last ` +
          `${humanAge(Math.round(t.imapRefusalWindowMs / 1000))}`,
        detail:
          `${refusals} connection attempt(s) were refused because a mailbox was already at its ` +
          `per-mailbox cap (threshold ${t.imapRefusalThreshold} in ` +
          `${humanAge(Math.round(t.imapRefusalWindowMs / 1000))}). At this rate the cap is no ` +
          `longer smoothing a burst — something is holding connections open, or one mailbox is ` +
          `being hammered by a retry loop. Attachment fetches, add-time probes and the send ` +
          `reconciler all queue behind it. The refusal log lines name the mailbox.`,
        count: refusals,
        oldestSeconds: null,
        // An INCIDENT despite the warning severity: the customer's attachment does not open.
        cls: "incident",
        // The counter is deployment-wide by design — see `IMAP_REFUSAL_KEY` for why it is not
        // keyed per mailbox — so this rule cannot answer how many accounts are behind it.
        affectedAccounts: null,
        fixHref: "/reliability",
      });
    }
  } catch (err) {
    const code = (err as { code?: string })?.code ?? (err as { cause?: { code?: string } })?.cause?.code;
    if (code !== "42501") throw err;
  }

  // ── 14. the credit roll-up went dark ───────────────────────────────────────────────────
  //
  // `billing_reconciliation_stale`'s exact shape, one table over, and for the same reason: the
  // console's whole spend read is served from the aggregates this pass writes, so a roll-up that
  // stopped does not fail anything. It serves figures that quietly stop moving — an account page
  // showing thirty daily bars that are all real and none of them from this week.
  //
  // Fires only where the pass is ARMED — a deployment that never runs it stays silent rather
  // than paging about a feature it does not have. Failed runs (error non-null) do not reset the
  // clock: a pass that fails every night is exactly as dark as one that stopped, and letting a
  // failure row count would mean this never fires at all, which is the quiet branch the rule
  // exists to remove. What arming means is the paragraph below the clock, and it is not the same
  // question as "has one ever completed".
  const [lastRollup] = await db
    .select({ ranAt: creditRollupRuns.ranAt })
    .from(creditRollupRuns)
    // ── A COMPLETED RUN IS NOT ENOUGH: IT MUST BE ONE THAT DID THE NIGHTLY WORK ────────
    //
    // Two shapes write this table. An HOURLY pass recomputes the last couple of days, and a
    // NIGHTLY one additionally runs the divergence check and prunes the setup-spend rows. Only
    // the nightly one refreshes lifetime totals, and only it can find a ledger that has drifted.
    //
    // Taking the newest COMPLETED row of either shape made this rule structurally unable to
    // report the failure that matters: the nightly pass could be missed or failing for a week
    // while the hourly passes kept succeeding, so the clock always looked fresh and the alert
    // never fired — while the totals, the divergence verdict and the prune all went stale. The
    // rule existed to notice figures that quietly stop moving, and it was reading the one signal
    // that keeps moving when they stop.
    //
    // `divergent_accounts` is the proof, and it is a natural one rather than a flag invented for
    // this: it is NULL unless the pass actually ran the divergence check, which only the nightly
    // shape does. A zero there is a real answer — no account diverged — and is not null.
    .where(and(isNull(creditRollupRuns.error), isNotNull(creditRollupRuns.divergentAccounts)))
    .orderBy(sql`${creditRollupRuns.ranAt} desc`)
    .limit(1);

  // ── ARMED IS NOT THE SAME QUESTION AS "HAS ONE EVER COMPLETED" ────────────────────────
  //
  // The filter above is the right CLOCK and the wrong ARMING TEST. A deployment whose nightly
  // roll-up has failed every time it ran writes rows carrying an error and no divergence
  // verdict, so the filter removes every one of them, the read above comes back empty, and the
  // rule is silent for ever — in exactly the state it exists to report. The silence is meant for
  // a deployment that never runs the pass at all, not for one that runs it nightly and never
  // gets through it, which is the louder of the two failures.
  //
  // So arming reads the OLDEST recorded attempt of either shape, successful or not. If this
  // table has been accumulating rows for longer than the staleness threshold and still holds no
  // completed nightly run, the divergence verdict is as absent as it would be had the pass
  // stopped, and the alert carries the age of that first attempt — a lower bound on how long the
  // figures have gone unverified. A deployment installed an hour ago, whose first nightly window
  // has not come round yet, is younger than the threshold and stays quiet.
  const [firstAttempt] = await db
    .select({ ranAt: creditRollupRuns.ranAt })
    .from(creditRollupRuns)
    .orderBy(sql`${creditRollupRuns.ranAt} asc`)
    .limit(1);

  const rollupSince = lastRollup?.ranAt ?? firstAttempt?.ranAt ?? null;
  if (rollupSince) {
    const staleSeconds = secondsBetween(now, rollupSince);
    if ((staleSeconds ?? 0) * 1000 > t.creditRollupStaleMs) {
      alerts.push({
        key: "credit_rollup_stale",
        kind: "credit_rollup_stale",
        severity: "warning",
        title: "The credit roll-up has stopped running",
        detail:
          (lastRollup
            ? `The last completed credit roll-up was ${humanAge(staleSeconds)} ago (threshold `
            : `No credit roll-up has ever completed the nightly work, and the oldest attempt on ` +
              `record is ${humanAge(staleSeconds)} old (threshold `) +
          `${humanAge(Math.round(t.creditRollupStaleMs / 1000))}). Nothing fails while this is ` +
          `dark: the Billing board and every account's usage panel keep rendering the aggregates ` +
          `from the last pass that ran, so the figures are real and simply stop moving. The ` +
          `ledger itself is untouched and nothing is lost — check the worker's pass registry.`,
        count: 1,
        oldestSeconds: staleSeconds,
        cls: "incident",
        affectedAccounts: null,
        fixHref: "/billing",
      });
    }
  }

  // ── 14b. a metered call was paid for and the cost table has no row for it ─────────────
  //
  // `aiUsageUnrecorded` (`ai-usage.ts`) is the detector written for the exact production state
  // its own header describes: `loadAiPorts(env)` called with one argument, an `onUsage` silently
  // defaulting, every credit debited and every cost row absent. The detector already existed and
  // nothing consulted it; this rule is the part that was missing.
  //
  // ALWAYS A SIGNAL, never an incident: the model call happened, the customer was served, and the
  // credit was debited correctly. What is dark is one column of the cost board, not the product —
  // `worker_down` and `billing_events_failed` are what page for those.
  //
  // `now`, exactly as the detector's own test calls it (`{ day: new Date() }`): a live check,
  // re-run every pass, that self-heals the moment ANY host records anything for the day — no
  // separate staleness window of this rule's own invention, because the detector already reads a
  // whole calendar day and a debit within the last few minutes racing the worker's write buffer
  // reads as "unrecorded" for at most that buffer's own flush interval, which is seconds, not the
  // hours this file's other staleness rules guard against.
  const usage = await aiUsageUnrecorded(db, { day: now });
  if (usage.unrecorded) {
    alerts.push({
      key: "ai_usage_unrecorded",
      kind: "ai_usage_unrecorded",
      severity: "warning",
      title: `AI usage went unrecorded on ${usage.missingHosts.join(", ")}`,
      detail:
        `A metered model call was debited today and ${usage.missingHosts.join(", ")} wrote no ` +
        `\`ai_usage_daily\` row for it. The credit was still spent and the mail still routed — ` +
        `this is the cost board's AI column going blind for that host, not an outage. Check the ` +
        `named host's \`onUsage\` wiring.`,
      count: usage.missingHosts.length,
      oldestSeconds: null,
      cls: "signal",
      // A host-scoped fact, not an account one — no account is more or less affected than any
      // other by one host's recorder going dark.
      affectedAccounts: null,
      fixHref: "/costs",
    });
  }

  // ── 15. THE OTHER alert driver has stopped running ─────────────────────────────────────
  //
  // ── EVALUATED BY THE OTHER DRIVER, AND THAT IS THE WHOLE RULE ──────────────────────────
  //
  // A driver cannot report its own death — that sentence is why there are two of them, and it is
  // exactly as true one level up as it is for `worker_down`. A pass that checked its OWN
  // `alert_pass_runs` row would be asking a running process whether it is running: the answer is
  // always yes, the rule could never fire, and the deployment would carry a guard that reads as
  // coverage and is decoration. So the driver names itself in `opts.driver` and this rule looks
  // at the OTHER row, always.
  //
  // The pairing is a two-element table rather than a boolean because the set of drivers is closed
  // (`alert_pass_runs`'s CHECK), and a third arm would have to be a deliberate change in both
  // places: a driver nobody watches is a driver whose death is invisible.
  //
  // A driver that has NEVER recorded a pass is silent here, on `billing_reconciliation_stale`'s
  // contract: a deployment that runs only one arm — a self-hosted install with no external
  // scheduler — must not be paged forever about an arm it deliberately does not have. The cost is
  // stated: the very first pass of a newly-armed second driver is what starts the watch, so an
  // arm that was configured and never once ran is invisible. That is visible on the board instead
  // (the panel shows both drivers, and "never" is rendered as "never").
  if (opts.driver) {
    const other: AlertDriver = opts.driver === "worker" ? "api" : "worker";
    const [row] = await db
      .select({ ranAt: alertPassRuns.ranAt, streak: alertPassRuns.sinkFailureStreak })
      .from(alertPassRuns)
      .where(eq(alertPassRuns.driver, other))
      .limit(1);
    if (row) {
      const darkSeconds = secondsBetween(now, row.ranAt);
      if ((darkSeconds ?? 0) * 1000 > t.alertDriverDarkMs) {
        alerts.push({
          key: `alert_driver_dark:${other}`,
          kind: "alert_driver_dark",
          severity: "critical",
          title: `The ${other} alert driver has not run in ${humanAge(darkSeconds)}`,
          detail:
            `The ${other} alert driver's last completed pass was ${humanAge(darkSeconds)} ago ` +
            `(threshold ${humanAge(Math.round(t.alertDriverDarkMs / 1000))}), reported by the ` +
            `${opts.driver} driver because no process can testify to its own death. ` +
            (other === "api"
              ? "The API driver is the ONLY observer of worker_down — while it is dark, a dead " +
                "sync worker pages nobody. Check the external scheduler and TF_ALERT_SECRET."
              : "The worker driver is the fast arm (one pass a minute); while it is dark, every " +
                "alert's detection latency is the API scheduler's cadence instead. Check the " +
                "worker's leader lock.") +
            ` Its last pass refused ${row.streak} delivery attempt(s) in a row.`,
          count: 1,
          oldestSeconds: darkSeconds,
          cls: "incident",
          affectedAccounts: null,
          fixHref: "/reliability",
        });
      }
    }
  }

  return alerts;
}

/**
 * The newest cloud migration this BUNDLE ships with — the `when` of the journal's last entry.
 *
 * A pinned constant rather than a read of the journal file, deliberately, and for two reasons.
 * This module's header rules out `node:fs` (the worker imports it and the desktop engine is
 * bundled from these packages), and — the load-bearing half — a constant compiled into the
 * artifact is what makes {@link AlertKind} `schema_behind` HOST-LOCAL: a deployment carrying an
 * older bundle carries an older constant and correctly says nothing, which is precisely the
 * question the rule asks.
 *
 * `journal-split.test.ts` asserts this equals the journal's true maximum, so a migration added
 * without moving this line is a red test rather than a rule that quietly stops noticing.
 */
export const CLOUD_JOURNAL_HEAD_WHEN = 1791328104216;

/** One project's summed traffic over the rule's window. */
export interface PlatformSignalWindow {
  provider: string;
  project: string;
  /**
   * Requests and 5xx summed over the COMPLETE buckets only — never over sampled ones.
   *
   * A sampled bucket's two counts are each a lower bound, but their RATIO is not, and the rate
   * threshold divides one by the other. Twenty errors in a sampled thousand crosses both floors
   * while ninety-nine thousand unseen successes put the true rate two orders of magnitude below
   * it, so a sampled window could page for a deployment having an ordinary day. Lower bounds are
   * safe in a numerator and unsafe in a quotient; the quotient is what this rule is.
   */
  requests: number;
  errors5xx: number;
  /** True when ANY row in the window was sampled — the panel says so, the rule ignores them. */
  truncated: boolean;
  /**
   * How many COMPLETE buckets contributed. **Zero means this project has never been measured in
   * this window**, and it is what gates the rule: with no complete bucket there is no rate to
   * judge, so the rule stays silent and the board says "not measured". That covers a deployment
   * with no platform token, a poller that has never successfully run, and one whose every read
   * was sampled — three states that must not be distinguishable from a rate of zero, because
   * none of them is a measurement.
   */
  completeBuckets: number;
  /** How many buckets were excluded as sampled. Rendered, never summed into the rate. */
  sampledBuckets: number;
  /** The newest `fetched_at` among the contributing rows — the panel's freshness stamp. */
  fetchedAt: Date;
}

/**
 * Sum `platform_signals` over the window, per project.
 *
 * ONE FUNCTION FOR THE RULE AND THE BOARD, which is the point: the panel says "12 of 900 requests"
 * and the rule pages on the same two numbers, so the surface an operator reads and the condition
 * that wakes them cannot drift apart — the same argument {@link evaluateAlerts} itself is built on.
 *
 * AN EMPTY RESULT IS THE UNCONFIGURED STATE, and callers must render it as "not measured" rather
 * than as zero. A deployment with no platform token writes no rows at all, so there is no row here
 * saying 0 — and the difference between "nobody asked" and "we asked and nothing failed" is the
 * whole reason this returns an array of what EXISTS instead of a figure per known project.
 */

/**
 * The width of ONE row in `platform_signals`, and it must equal `SIGNAL_WINDOW_MS` in
 * `packages/services/src/platform-signals.ts`, which is what actually writes the rows.
 *
 * Duplicated rather than imported because `packages/db` does not depend on `packages/services`
 * and must not start. `platform-signals.test.ts` asserts the two are equal, so the copy cannot
 * drift: a reader that assumed a different bucket width would align its cut to a boundary the
 * writer never uses, which is the same off-by-one-bucket this constant was added to remove.
 */
export const SIGNAL_BUCKET_MS = 5 * 60 * 1000;

export async function platformSignalWindow(
  db: Tx, now: Date, windowMs: number,
): Promise<PlatformSignalWindow[]> {
  // ── THE CUT IS ALIGNED TO A BUCKET BOUNDARY, NOT TO `now` ────────────────────────────
  //
  // The poller writes one row per CLOSED five-minute bucket, so a raw `now - 15min` cut lands
  // mid-bucket and drops the oldest one. At 12:07 the held buckets are 11:50, 11:55 and 12:00;
  // `cut = 11:52` excludes 11:50, leaving TEN minutes of traffic under a rule that advertises
  // fifteen — a numerator formed over two buckets divided by a window described as three. The
  // absolute floor then needs ten errors in two buckets instead of three, and the rate is
  // computed over a denominator that is short by the same third.
  //
  // Flooring `now` to the bucket first makes the cut land exactly on a boundary: at 12:07 that
  // is 12:05, and 12:05 − 15min = 11:50, which is the oldest of the three complete buckets.
  //
  // ── AND THE WINDOW IS CLOSED AT BOTH ENDS, BECAUSE TWO CLOCKS WRITE AND READ IT ───────
  //
  // The poller and this evaluator run in different processes, on hosts whose clocks agree only
  // approximately. A lower bound alone therefore admits a bucket the reader has not reached yet:
  // if the poller's clock is a minute ahead, it closes and persists the 12:05 bucket while this
  // pass still floors `now` to 12:05, and `window_start >= 11:50` then sums FOUR buckets into a
  // rate the rule describes — and thresholds — as three. The extra bucket is partial by
  // construction, so it lifts the error ratio without lifting the request count that would
  // justify it, and the direction of the mistake is a false page.
  //
  // The floored boundary is the exclusive upper bound as well as the anchor of the lower one, so
  // the window is always exactly `windowMs` wide and always made of buckets that closed before
  // this pass began.
  const bucketEnd = new Date(
    Math.floor(now.getTime() / SIGNAL_BUCKET_MS) * SIGNAL_BUCKET_MS,
  );
  const cut = new Date(bucketEnd.getTime() - windowMs);
  const rows = await db
    .select({
      provider: platformSignals.provider,
      project: platformSignals.project,
      // FILTERED to complete buckets — see the field's own note. `coalesce` because a project
      // whose every bucket was sampled sums to NULL here, and that project must read as zero
      // complete buckets rather than as a zero rate.
      requests: sql<number>`coalesce(sum(${platformSignals.requests}) filter (where not ${platformSignals.truncated}), 0)::int`,
      errors5xx: sql<number>`coalesce(sum(${platformSignals.errors5xx}) filter (where not ${platformSignals.truncated}), 0)::int`,
      truncated: sql<boolean>`bool_or(${platformSignals.truncated})`,
      completeBuckets: sql<number>`count(*) filter (where not ${platformSignals.truncated})::int`,
      sampledBuckets: sql<number>`count(*) filter (where ${platformSignals.truncated})::int`,
      // FILTERED like the sums above it, and for the same reason. A sampled bucket contributes
      // no requests and no errors, so letting its `fetched_at` win the max reported figures as
      // freshly read whose newest CONTRIBUTING data was older — the stamp describing a row that
      // was deliberately excluded from the numbers beside it. `coalesce` to the unfiltered max
      // so a project whose every bucket was sampled still has a timestamp to render; its
      // `completeBuckets` is zero, so the board says "not measured" rather than trusting it.
      fetchedAt: sql<Date>`coalesce(
        max(${platformSignals.fetchedAt}) filter (where not ${platformSignals.truncated}),
        max(${platformSignals.fetchedAt})
      )`,
    })
    .from(platformSignals)
    .where(sql`${platformSignals.windowStart} >= ${cut.toISOString()}::timestamptz
      and ${platformSignals.windowStart} < ${bucketEnd.toISOString()}::timestamptz`)
    .groupBy(platformSignals.provider, platformSignals.project);
  return rows.map((r) => ({
    provider: r.provider,
    project: r.project,
    requests: Number(r.requests ?? 0),
    errors5xx: Number(r.errors5xx ?? 0),
    truncated: r.truncated === true,
    completeBuckets: Number(r.completeBuckets ?? 0),
    sampledBuckets: Number(r.sampledBuckets ?? 0),
    fetchedAt: new Date(r.fetchedAt as unknown as string),
  }));
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
  /**
   * How long a still-firing CRITICAL alert waits before paging again. Default one hour.
   * Non-critical tiers hold for {@link renotifyUnchangedMs} while their signature is
   * unchanged; a signature change re-pages every tier immediately.
   */
  repeatMs?: number;
  /**
   * How long an UNCHANGED standing non-critical alert waits before paging again. Default
   * {@link DEFAULT_ALERT_RENOTIFY_UNCHANGED_MS} (24 h). "Unchanged" is the alert's
   * {@link Alert.signature} matching the one recorded at the last notification.
   */
  renotifyUnchangedMs?: number;
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
 * So the decision to notify is a CLAIM — one row lock, the due decision, one UPDATE, all
 * inside a transaction that spans microseconds and zero I/O:
 *
 * ```
 *   BEGIN;
 *   SELECT notified_at, notified_signature, claimed_until
 *     FROM alert_state WHERE alert_key = $k FOR UPDATE;
 *   -- leased? refuse. due? (never notified / past the tier's interval / changed past the floor)
 *   UPDATE alert_state SET claimed_until = <now + ttl> WHERE alert_key = $k;
 *   COMMIT;
 * ```
 *
 * The winner claims and notifies; the loser blocks on the row lock, reads the committed lease,
 * and stays quiet. The claim writes THE LEASE AND NOTHING ELSE — `notified_at` and
 * `notified_signature` move only on the guarded confirm, so a failed delivery, a crashed pass
 * and a never-was are all one state: the row exactly as it stood before the claim, minus a
 * lease that has expired or been cleared. No advisory lock, and no transaction ACROSS
 * DELIVERY, deliberately: {@link deliver} does network I/O, and holding a Postgres transaction
 * open across an HTTP call is the `idle in transaction` pathology that caused the outage this
 * observer exists to catch — the claim's own two-statement transaction holds no such thing.
 *
 * ## The claim is a LEASE (`claimed_until`), so a pass that dies mid-delivery does not swallow
 * ## the page — and `notified_at` means exactly one thing
 *
 * The lease used to be ENCODED in `notified_at` (a value just past the due cutoff). That was
 * sound with one reader; the renotify policy's changed-condition arm compares the last
 * confirm's AGE against a much shorter floor, and to that reader a live lease — deliberately
 * placed near the far cutoff — read as an old confirmation, so a second driver with a
 * different signature could reclaim a mid-delivery row, page a duplicate and orphan the first
 * claim's settlement (review-caught before it shipped a page). `claimed_until` states the
 * lease as itself: every due arm refuses a future lease outright, `notified_at` is always the
 * last CONFIRMED notification, and then:
 *
 *  · at least one sink accepted ⇒ **confirm**: `notified_at = now`, `notified_signature =
 *    <sig>`, `notify_count + 1`, `claimed_until = NULL` — the confirm is the ONLY writer of
 *    the stamp and the signature, so the row always says "this condition, told at this time";
 *  · nothing accepted ⇒ **release**: `claimed_until = NULL` and nothing else — the claim
 *    wrote nothing else, so the retry re-fires by construction;
 *  · the pass dies in between ⇒ nobody writes anything, and the lease expires on its own —
 *    `claimTtlMs` later the row is claimable again with its true confirm history intact,
 *    which is the release's exact state: crash and failed delivery are one case.
 *
 * Both settles are guarded by `claimed_until = <the lease value we wrote>`, so a pass can only
 * ever settle its OWN claim — if the condition resolved and the row was deleted underneath, or
 * another driver claimed after the lease expired, the guard matches nothing and that is the
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

/**
 * Advance the IN-MEMORY sink streak for one delivery attempt, and say what it escalated.
 *
 * ── WHY THIS IS A FUNCTION AND NOT INLINE, WHICH IT WAS ───────────────────────────────────
 *
 * Two paths deliver: the ordinary pass, and the schema-behind path that delivers WITHOUT
 * persisting because the table it would persist into is the one missing a column. The second
 * originally reported a zero streak and an undefined health, which made a sink that refuses
 * those pages invisible — its attempts never advanced, no escalation ever fired, and `/health`
 * kept publishing stale sink health while every page about a half-finished deploy was refused.
 * A pager that cannot deliver the schema alert is exactly the pager somebody must be told about.
 *
 * Only the DATABASE write differs between the two paths; the delivery and its outcome are real
 * in both, so the accounting is shared rather than copied. A second copy of this arithmetic is
 * how the two paths would drift.
 */
function accountDelivery(
  streak: DeliveryStreak | undefined,
  sinks: readonly AlertSink[],
  outcomes: readonly SinkOutcome[],
  delivered: readonly string[],
  failed: readonly string[],
  errors: readonly string[],
  now: Date,
  opts: AlertPassOptions,
): { escalate: SinkEscalation | null; sinkDegraded: SinkDegradation[] } {
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
          escalate = { consecutiveFailures: streak.consecutiveFailures, sinks: [...failed], errors: [...errors] };
        }
        // Per-arm reports are deliberately NOT emitted here — see {@link SinkDegradation}. The
        // per-arm counters above still advanced, and their `escalated` flags are still false, so
        // an arm that stayed dead is named on the first pass the other one recovers.
      }
    }

  return { escalate, sinkDegraded };
}

export async function runAlertPass(db: Tx, opts: AlertPassOptions = {}): Promise<AlertPassResult> {
  const now = opts.now ?? new Date();
  const repeatMs = opts.repeatMs ?? DEFAULT_ALERT_REPEAT_MS;
  const renotifyUnchangedMs = opts.renotifyUnchangedMs ?? DEFAULT_ALERT_RENOTIFY_UNCHANGED_MS;
  const claimTtlMs = opts.claimTtlMs ?? DEFAULT_CLAIM_TTL_MS;
  const shards = opts.shards ?? [0];
  const sinks = opts.sinks ?? [];
  const firing = await evaluateAlerts(db, opts);

  // ── THE DATABASE IS OLDER THAN THIS BUNDLE: DELIVER, DO NOT PERSIST ──────────────────
  //
  // `alert_state` is one of the tables the older schema lacks columns for — the preflight's
  // marker IS a column this function writes on every observation — so the ordinary path would
  // raise 42703 while trying to record the finding that explains the outage. The whole rule
  // would be unreachable a second way, having just been made reachable a first.
  //
  // So this path hands the alert straight to the sinks and touches no table. The costs are
  // stated rather than hidden: there is no dedup and no cooldown here, so a host left in this
  // state pages once per pass. That is deliberate — the condition is a half-finished deploy,
  // it is resolved by running the migrations, and it self-clears on the next pass once they
  // are run. A quiet version of this alert would be worth nothing.
  if (isSchemaBehind(firing)) {
    const ctx: AlertNotifyContext = {
      source: opts.source ?? "api",
      environment: opts.environment ?? "production",
      now,
    };
    const { delivered, failed, errors, outcomes } = await deliver(sinks, firing, ctx);
    // The SAME accounting the ordinary path runs — only the database write is skipped here.
    const behindStreak = opts.deliveryStreak;
    const behindAcct = accountDelivery(
      behindStreak, sinks, outcomes, delivered, failed, errors, now, opts,
    );
    return {
      now: now.toISOString(),
      firing,
      notified: firing,
      // NOTHING IS RESOLVED FROM HERE, and that is not an omission. This pass could not read
      // `alert_state` at all, so it knows nothing about what was open — and "I could not look"
      // must never be spelled as "it cleared", which is the same rule the scoped-kind exemption
      // above enforces for a rule an arm declines to evaluate.
      resolved: [],
      delivered,
      failedSinks: failed,
      sinkErrors: errors,
      undeliverable: sinks.length === 0,
      // ── THE STREAK IS STILL ACCOUNTED FOR, EVEN THOUGH NOTHING IS PERSISTED ────────
      //
      // Only the DATABASE write is skipped here; the delivery is real and its outcome is real.
      // Reporting a zero streak and an undefined health made a sink that refuses these pages
      // invisible: its attempts never advanced, no escalation ever fired, and `/health` kept
      // publishing stale or zero sink health while every page about a half-finished deploy was
      // being refused. A pager that cannot deliver the schema alert is precisely the pager
      // somebody needs to know about, so the in-memory streak the caller handed us is advanced
      // exactly as the ordinary path advances it.
      sinkFailureStreak: behindStreak?.consecutiveFailures ?? 0,
      escalate: behindAcct.escalate,
      sinkOutcomes: outcomes,
      sinkDegraded: behindAcct.sinkDegraded,
      sinkHealth: sinkHealthOf(sinks, behindStreak),
    };
  }

  const firingKeys = new Set(firing.map((a) => a.key));

  const existing = await db
    .select({
      alertKey: alertState.alertKey,
      kind: alertState.kind,
      notifiedAt: alertState.notifiedAt,
      notifiedSignature: alertState.notifiedSignature,
      notifyCount: alertState.notifyCount,
    })
    .from(alertState);
  const byKey = new Map(existing.map((r) => [r.alertKey, r]));

  // NO same-key ESCALATION ARM by severity flip alone — that existed for one pass's lifetime
  // and it was twice discarded, because without carried state it lacked the claim's three
  // properties (page-at-once, retry-after-failure, crash-survival). A tier that must page
  // immediately is a tier with its OWN KEY (`sync_lag:critical`): a new key's first
  // observation has `notified_at` NULL, which the ordinary claim below pages at once. What DOES
  // exist now is the SIGNATURE arm, which is that old idea rebuilt WITH the state it lacked:
  // `notified_signature` is the last CONFIRMED condition (written only by the guarded confirm
  // — a claim writes nothing but its `claimed_until` lease, and the lease is what stops two
  // drivers from both seeing "changed"), so a failed delivery retries and a crashed pass
  // costs `claimTtlMs`, not the interval. A severity flip changes the default signature and
  // therefore pages once the change-arm floor passes — through the claim, not around it.

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
        // BOTH CLASSES ARE RECORDED HERE. A signal opens, updates and resolves its row exactly
        // as an incident does — it is on the board, it carries an `opened_at` an operator can
        // age, and it clears by itself. The class changes what happens at DELIVERY and nothing
        // else; a signal that was not written down would be an observation nobody could act on
        // later, which is not the same thing as one that does not page.
        cls: alertClass(alert),
        affectedAccounts: alert.affectedAccounts ?? null,
        fixHref: alert.fixHref ?? null,
        // WHAT THE RULE SAID, so no reader has to invent it. Every surface that reads this table
        // rather than evaluating — a driverless console read, the two driver-keyed rules, the
        // role-scoped one — used to reconstruct these two: the count as a hardcoded 1, the title
        // as the detail's first sentence.
        title: alert.title,
        count: alert.count,
      })
      .onConflictDoUpdate({
        target: alertState.alertKey,
        // `opened_at` is NOT in the update set: it is when the fault STARTED, and an
        // operator asking "how long has this been broken" is asking about that value.
        //
        // `cls` IS, and it has to be: the promoting rules (`sync_lag`, `storage_at_cap`) compute
        // their class from a population that moves between passes, so a condition that spreads
        // from two accounts to twenty must become an incident on the row a human is looking at
        // and not only in the pass's return value. The class is in those rules' signatures too,
        // so the promotion re-pages rather than inheriting the signal's confirmation.
        set: {
          lastSeenAt: now,
          severity: alert.severity,
          detail: alert.detail,
          kind: alert.kind,
          cls: alertClass(alert),
          affectedAccounts: alert.affectedAccounts ?? null,
          fixHref: alert.fixHref ?? null,
          title: alert.title,
          count: alert.count,
          // ── A DEMOTION CLEARS THE DELIVERY HISTORY, AND THE SENTENCE ABOVE NEEDED IT ──
          //
          // The comment one block up says the class is in the promoting rules' signatures "so
          // the promotion re-pages rather than inheriting the signal's confirmation". That was
          // half true and the missing half suppressed a real outage.
          //
          // `notified_signature` is written ONLY by a confirmed delivery, and a signal never
          // delivers. So a key that pages as an incident, drops to a signal, and comes back is
          // compared against the signature of the LAST INCIDENT — which is identical, because it
          // is the same condition. `storage_at_cap` going 5 → 4 → 5 is the ordinary shape of it:
          // the return to five reads as UNCHANGED and is held for the renotify interval, so the
          // second outage pages nobody for up to a day.
          //
          // Demoting to a signal therefore ENDS the occurrence: the stamp, the signature and the
          // count all go, so a later promotion is a first observation again and the claim pages
          // it at once. Promotions leave the history alone — that direction was never broken,
          // and clearing it there would re-page every pass a population wobbled upward.
          notifiedAt: sql`case when ${alertState.cls} = 'incident' and ${alertClass(alert)} = 'signal'
            then null else ${alertState.notifiedAt} end`,
          notifiedSignature: sql`case when ${alertState.cls} = 'incident' and ${alertClass(alert)} = 'signal'
            then null else ${alertState.notifiedSignature} end`,
          notifyCount: sql`case when ${alertState.cls} = 'incident' and ${alertClass(alert)} = 'signal'
            then 0 else ${alertState.notifyCount} end`,
          // ── AND THE LEASE GOES WITH THEM, WHICH IS THE CONCURRENT HALF ──────────────
          //
          // Clearing the history alone is not enough while two drivers overlap. The settle that
          // follows a delivery is guarded ONLY by `claimed_until = <the lease this pass took>`,
          // so an incident sender still in flight when the condition demotes will match that
          // guard afterwards and write its OLD INCIDENT SIGNATURE back onto the row that is now
          // a signal — restoring exactly the suppression the lines above just removed, with no
          // pass having done anything wrong. Dropping the lease makes that settle match nothing,
          // which is the outcome it should have: it is confirming a page for a condition that
          // has since stopped being one.
          claimedUntil: sql`case when ${alertState.cls} = 'incident' and ${alertClass(alert)} = 'signal'
            then null else ${alertState.claimedUntil} end`,
        },
        // ── THE OBSERVATION FENCE: A STALE PASS MAY NOT OVERWRITE A NEWER ONE ────────────
        //
        // Two drivers overlap by design, and their evaluations can land out of order — a pass
        // that read the world at 12:00 can reach this statement after one that read it at 12:01.
        // Unconditionally, that reorders the world in BOTH directions and each is a real page:
        //
        //  · a stale SIGNAL landing after a promotion demotes the row and, by the clauses above,
        //    clears the notification state and the lease of a live incident — so the promotion
        //    that had just paged is un-paged and the next pass treats it as first-seen;
        //  · a stale INCIDENT landing after a demotion resurrects a condition that has cleared
        //    and pages a human about it.
        //
        // `last_seen_at` is this pass's own `now`, so it is exactly the observation's age. The
        // fence keeps the NEWEST observation and makes an older one a no-op — which is also why
        // the claim above re-reads `cls` under its lock rather than trusting what it evaluated:
        // this statement may have declined to apply what that pass saw.
        setWhere: sql`${alertState.lastSeenAt} <= ${now.toISOString()}::timestamptz`,
      });
  }

  // ── CLAIM the notifications this pass is allowed to send ──────────────────────────────
  //
  // One SHORT transaction per firing alert — `SELECT … FOR UPDATE`, the due decision, one
  // UPDATE — and the row it does or does not claim IS the decision. The lock is held across
  // two statements and zero I/O: the header's rule against a surrounding transaction is about
  // holding one open across DELIVERY (the `idle in transaction` pathology), and this is
  // microseconds on one row. What the lock buys over the single-UPDATE form is that the due
  // decision and the lease write are one atomic act over the row's committed values — a
  // concurrent driver blocks on the lock and then reads the lease this claim just wrote.
  //
  // AN ACTIVE LEASE REFUSES EVERY ARM. `claimed_until` in the future means another driver's
  // page for this key is in flight; whatever this pass's alert says — even a changed
  // signature — the row is not claimable until that settles or expires. This is the guard the
  // encoded-lease scheme could not express (see the header): a changed condition observed
  // mid-delivery is simply picked up by a following pass, one cadence later.
  //
  // THREE ARMS then make an alert due, judged from the TRUE last confirm (`notified_at`):
  //   · never notified (`notified_at IS NULL`) — a first observation pages at once;
  //   · the tier's interval has passed — hourly for critical (`repeatMs`), the long
  //     unchanged-hold for everything else (`renotifyUnchangedMs`): a standing warning owes
  //     one page and a daily reminder, not an hourly restatement of its own age;
  //   · the CONDITION CHANGED — the firing alert's signature differs from the recorded one
  //     and the last confirm is at least `claimTtlMs` old. That floor is the stale-evaluation
  //     guard: two drivers overlap, the slower one's alert was computed from an older firing
  //     snapshot, and without the floor its unequal signature would reclaim a condition a
  //     newer pass had just confirmed — paging stale numbers, then paging again when the
  //     fresh ones differ. A pass's evaluate-to-claim span is seconds, so a real change still
  //     pages within one pass cadence plus the floor.
  //     `notified_signature IS NULL` (pre-column rows) deliberately reads as UNCHANGED — a
  //     deploy must not page every standing alert once because the column arrived.
  //
  // THE SIGNATURE PERSISTS ONLY ON A CONFIRM. A claim writes the lease and nothing else:
  // concurrent duplicates are the lease's job now, and a signature written at claim time was
  // the crash hole — a pass dying mid-delivery would leave the NEW signature standing under an
  // expired lease, and the next pass would read the changed condition as already notified,
  // suppressing it for the whole tier interval instead of retrying after the TTL. With the
  // signature moving only on the guarded confirm, a crash and a failed delivery leave the row
  // byte-identical to before the claim (minus the expired lease), so the retry re-fires by
  // construction.
  //
  // The due decision is taken in JS over the LOCKED row's own values — Date compares on
  // `getTime()`, no SQL fragment with a `Date` in it, which retires this block's old binding
  // hazard along with the race.
  //
  // ── AND ONLY INCIDENTS ARE EVER CLAIMED ───────────────────────────────────────────────
  //
  // The class gate is HERE, at the claim, and not later at the delivery call. Both would keep a
  // signal out of a sink, but only this one keeps the whole notification machinery off it: a
  // signal never takes a lease, never stamps `notified_at`, never advances `notify_count` and
  // never appears in `notified`. That matters because those fields are the record of "a human
  // was told", and a signal writing them would make the row claim something untrue — and would
  // make a later PROMOTION of that key (`sync_lag` spreading across accounts) read as an alert
  // that had already been delivered, suppressing the page for the whole tier interval. Gating at
  // the sink call would have left exactly that hole.
  const leaseUntil = new Date(now.getTime() + claimTtlMs);
  const claimed: Alert[] = [];
  for (const alert of firing) {
    if (alertClass(alert) !== "incident") continue;
    const intervalMs = alert.severity === "critical" ? repeatMs : renotifyUnchangedMs;
    const dueBefore = new Date(now.getTime() - intervalMs);
    // The stale-evaluation floor for the change arm — see the header bullet.
    const changeBefore = new Date(now.getTime() - claimTtlMs);
    const sig = alertSignature(alert);
    const won = await db.transaction(async (tx) => {
      const [cur] = await tx
        .select({
          notifiedAt: alertState.notifiedAt,
          notifiedSignature: alertState.notifiedSignature,
          claimedUntil: alertState.claimedUntil,
          // THE PERSISTED CLASS, read under the lock — see the check below.
          cls: alertState.cls,
          lastSeenAt: alertState.lastSeenAt,
        })
        .from(alertState)
        .where(eq(alertState.alertKey, alert.key))
        .limit(1)
        .for("update");
      if (!cur) return false; // resolved underneath this pass — nothing to page
      // ── THE CLASS IS RE-READ UNDER THE LOCK, NOT TAKEN FROM THIS PASS'S MEMORY ────────
      //
      // The loop above skips signals using `alertClass(alert)` — this pass's OWN evaluation,
      // computed before the lock was taken. With two drivers overlapping that is a stale read:
      // pass A evaluates an incident, pass B demotes the same key to a signal and clears its
      // notification state (which a demotion must do, or a later promotion is suppressed), and
      // A then enters this transaction, sees `notified_at = null`, and pages for a condition
      // that has since stopped being one. The row is the authority precisely because it is the
      // thing both passes serialise on; the in-memory class is only a hint about what to try.
      if (cur.cls === "signal") return false;
      const heldUntil = cur.claimedUntil ? new Date(cur.claimedUntil as unknown as string) : null;
      if (heldUntil !== null && heldUntil.getTime() > now.getTime()) return false; // in flight
      const notifiedAt = cur.notifiedAt ? new Date(cur.notifiedAt as unknown as string) : null;
      const due =
        notifiedAt === null ||
        notifiedAt.getTime() <= dueBefore.getTime() ||
        (cur.notifiedSignature !== null &&
          cur.notifiedSignature !== sig &&
          notifiedAt.getTime() <= changeBefore.getTime());
      if (!due) return false;
      // THE LEASE AND NOTHING ELSE — see the signature bullet above: a claim that wrote the
      // signature would suppress a crashed changed-condition page for the whole tier
      // interval. `notified_at` and `notified_signature` move only on the guarded confirm.
      await tx
        .update(alertState)
        .set({ claimedUntil: leaseUntil })
        .where(eq(alertState.alertKey, alert.key));
      return true;
    });
    if (won) claimed.push(alert);
  }
  const toNotify = claimed;

  // ── resolve what is no longer firing ──────────────────────────────────────────────────
  //
  // DELETE rather than a `resolved_at` column: `alert_state` is then a live list of what is
  // wrong, which is both what the console wants to render and what makes "did this page
  // already?" a single row lookup. The history that matters is the log line, which is
  // structured and timestamped and is not going to be queried by this table.
  //
  // ── BUT A PASS MAY ONLY RESOLVE WHAT IT ACTUALLY EVALUATED ────────────────────────────
  //
  // Some rules are evaluated by only ONE of the two arms, and for those "not in my firing set"
  // is not the same statement as "no longer true". A pass that resolved them anyway would
  // DELETE the row the other arm had just opened. The consequence is not a missed page but a
  // flapping one — open, page, deleted, re-opened with `notified_at` back to NULL, paged again
  // on the other arm's next pass, for ever, with `opened_at` reset each time so "how long has
  // this been broken" reads as seconds.
  //
  // ── THIS USED TO NAME ONE KIND, AND FOUR MORE HAD JOINED IT ───────────────────────────
  //
  // The exemption was written for `worker_down` when that was the only rule an arm declined,
  // and it tested `r.kind !== "worker_down"`. Cloud 0030 added four rules with exactly the same
  // property and none of them was covered, so all four flapped every cadence:
  //
  //  · `worker_degraded:S` and `ai_provider_down:S` sit inside the same `for (const shard of
  //    shards)` loop as `worker_down`, and the WORKER passes `shards: []` — so it evaluates
  //    none of the three, and deleted the two it was not exempted from one minute after the
  //    API arm opened them.
  //  · `schema_behind:D` and `alert_driver_dark:D` are keyed by DRIVER, and each arm evaluates
  //    exactly one key: its own for `schema_behind`, the other's for `alert_driver_dark`. So
  //    each arm deleted the other's row on every pass — and this pair flaps while BOTH hosts
  //    are perfectly healthy, which is the worst version of it.
  //
  // The set is therefore keyed by WHAT THIS PASS ACTUALLY EVALUATED rather than by a kind
  // name, so a sixth scoped rule cannot be added without either appearing here or failing the
  // cross-driver test that now covers this.
  //
  // Residue, stated rather than discovered: a scoped row nothing evaluates any more (a shard
  // removed from the configuration, a driver name retired) is never resolved here and has to
  // be deleted by hand. That is the safe direction — the alternative is the flap above.
  const evaluatedScopedKeys = new Set<string>();
  for (const s of shards) {
    evaluatedScopedKeys.add(`worker_down:${s}`);
    evaluatedScopedKeys.add(`worker_degraded:${s}`);
    evaluatedScopedKeys.add(`ai_provider_down:${s}`);
  }
  if (opts.driver) {
    evaluatedScopedKeys.add(`schema_behind:${opts.driver}`);
    evaluatedScopedKeys.add(`alert_driver_dark:${opts.driver === "worker" ? "api" : "worker"}`);
  }
  // Only the WORKER arm runs on a handle that holds `auth_throttle`, so only the worker may
  // resolve the refusal incident. The API arm cannot read the counter in a hardened deployment
  // and must therefore not claim the condition has cleared. In a deployment where the API CAN
  // read it, the rule fires, the key is in `firingKeys`, and this exemption never applies —
  // so the narrower rule costs nothing there.
  if (opts.driver === "worker") evaluatedScopedKeys.add("imap_admission_refused");
  const resolved = existing
    .filter((r) => !firingKeys.has(r.alertKey))
    .filter((r) => !SCOPED_ALERT_KINDS.has(r.kind) || evaluatedScopedKeys.has(r.alertKey))
    .map((r) => r.alertKey);
  for (const key of resolved) {
    await db.delete(alertState).where(eq(alertState.alertKey, key));
  }

  const streak = opts.deliveryStreak;
  if (toNotify.length === 0) {
    // THE QUIET PASS IS THE ONE THAT MOST HAS TO BE RECORDED. A driver whose deployment is
    // healthy delivers nothing for weeks, and if only delivering passes wrote a row then a
    // healthy driver and a dead one would leave identical evidence — which is the entire failure
    // `alert_pass_runs` exists to close, reproduced inside the write that closes it.
    await recordAlertPass(db, {
      driver: opts.driver,
      now,
      firing: firing.length,
      delivered: 0,
      failedSinks: 0,
      sinkFailureStreak: streak?.consecutiveFailures ?? 0,
      sinksConfigured: sinks.length,
    });
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
  const { escalate, sinkDegraded } = accountDelivery(
    streak, sinks, outcomes, delivered, failed, errors, now, opts,
  );

  // ── settle every claim: CONFIRM if something accepted, otherwise RELEASE ───────────────
  //
  // Guarded by `claimed_until = <this pass's lease>` so a pass can only settle its own claim.
  // A row that was deleted as resolved, or claimed by another driver after this lease
  // expired, matches nothing — and in both cases doing nothing is right.
  //
  // Releasing is what keeps a misconfigured webhook self-correcting rather than a silent
  // hole, and `notify_count` moves ONLY on a confirm, so it counts pages that were actually
  // accepted by a sink and never claims that failed. A CONFIRM is where `notified_at` and
  // `notified_signature` land, together — the row then says "this condition, told at this
  // time". A RELEASE clears the lease and nothing else: the claim wrote nothing else, so the
  // row is byte-identical to before the claim and the retry re-fires by construction — the
  // exact state an EXPIRED lease (a crashed pass) leaves too, which is what makes the crash
  // path and the failed-delivery path one case instead of two.
  for (const alert of claimed) {
    const settle = delivered.length > 0
      ? {
        notifiedAt: now,
        notifiedSignature: alertSignature(alert),
        notifyCount: sql`${alertState.notifyCount} + 1`,
        claimedUntil: null,
      }
      : { claimedUntil: null };
    await db
      .update(alertState)
      .set(settle)
      .where(and(eq(alertState.alertKey, alert.key), eq(alertState.claimedUntil, leaseUntil)));
  }

  await recordAlertPass(db, {
    driver: opts.driver,
    now,
    firing: firing.length,
    delivered: delivered.length,
    failedSinks: failed.length,
    sinkFailureStreak: streak?.consecutiveFailures ?? 0,
    sinksConfigured: sinks.length,
  });

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

/** What one pass records about itself. See {@link recordAlertPass}. */
interface AlertPassRecord {
  driver: AlertDriver | undefined;
  now: Date;
  firing: number;
  delivered: number;
  failedSinks: number;
  sinkFailureStreak: number;
  /** How many sinks this arm had. ZERO is the finding — it cannot page anybody. */
  sinksConfigured: number;
}

/**
 * Stamp this driver's pass on `alert_pass_runs` — the write `alert_driver_dark` reads.
 *
 * ── BEST-EFFORT, AND THE DIRECTION IS DELIBERATE ──────────────────────────────────────────
 *
 * This never throws. It is bookkeeping ABOUT the alert pass, and an alert pass that died because
 * its own bookkeeping failed would be the observability code causing the outage it exists to
 * report — `writeHeartbeat` carries the same contract for the same reason, one file down.
 *
 * The residual is worth naming rather than leaving to be discovered: a driver whose row-write
 * keeps failing while its passes keep succeeding will eventually be reported dark by the other
 * arm. That is a FALSE page, and it is the acceptable direction — the alternative is a driver
 * whose write fails silently and is therefore never reported dark at all, which is the exact
 * silence this table was added to remove. A false page is loud and gets fixed.
 *
 * A caller with no `driver` writes nothing: it is not one of the two arms (see
 * {@link EvaluateOptions.driver}), and a runbook `curl` recording itself as the API driver would
 * hold that driver's watch open while nothing was scheduled.
 */
async function recordAlertPass(db: Tx, rec: AlertPassRecord): Promise<void> {
  if (!rec.driver) return;
  try {
    await db
      .insert(alertPassRuns)
      .values({
        driver: rec.driver,
        ranAt: rec.now,
        firing: rec.firing,
        delivered: rec.delivered,
        failedSinks: rec.failedSinks,
        sinkFailureStreak: rec.sinkFailureStreak,
        sinksConfigured: rec.sinksConfigured,
      })
      .onConflictDoUpdate({
        target: alertPassRuns.driver,
        set: {
          ranAt: rec.now,
          firing: rec.firing,
          delivered: rec.delivered,
          failedSinks: rec.failedSinks,
          sinkFailureStreak: rec.sinkFailureStreak,
          sinksConfigured: rec.sinksConfigured,
        },
        // ── AN OLDER PASS MAY NOT OVERWRITE A NEWER ONE ─────────────────────────────────
        //
        // Nothing serialises two passes of the same driver. The API arm is poked by a scheduler
        // whose retry can arrive while the first call is still running, and the worker arm runs
        // on a plain interval that starts the next pass whether or not the last one finished. A
        // slow pass therefore finishes AFTER a fast one that started later, and an unfenced
        // upsert then writes its older snapshot over the newer row.
        //
        // Every column here is part of that snapshot, so the damage is not only a `ran_at` that
        // walks backwards: the firing count, the delivery count and the sink-failure streak all
        // revert to what the deployment looked like earlier, and the Reliability panel reports a
        // driver as stale — or reports a sink as healthy — on evidence that has been superseded.
        // A streak in particular is a running total, and rewinding it re-arms an alert the newer
        // pass had already escalated past.
        //
        // The fence is the row's own stamp, the same shape the observation upsert uses further
        // up: the update applies only when the row it is replacing is not already newer. The
        // loser writes nothing and says nothing — its pass still happened, and the row simply
        // continues to describe the most recent one.
        setWhere: sql`${alertPassRuns.ranAt} <= ${rec.now.toISOString()}::timestamptz`,
      });
  } catch { /* see the header: the pass must outlive its own bookkeeping */ }
}

/** One driver's last recorded pass — what the Reliability panel renders for both arms. */
export interface AlertDriverStatus {
  driver: AlertDriver;
  /** null ⇒ this arm has NEVER recorded a pass, which is not the same as "it is fine". */
  ranAt: Date | null;
  firing: number;
  delivered: number;
  failedSinks: number;
  sinkFailureStreak: number;
  /**
   * How many sinks this arm had on its last pass. ZERO means it CANNOT PAGE ANYBODY, and no
   * other field on this row can say so: an arm that never attempts a delivery never fails one,
   * so `sinkFailureStreak` sits at zero and reads exactly like a healthy arm.
   */
  sinksConfigured: number;
}

/**
 * Both drivers' standing status, ALWAYS two rows.
 *
 * Driven off the closed driver set rather than off what the table happens to hold, on
 * `sinkHealthOf`'s argument next door: an arm that has never recorded a pass must be PRESENT and
 * say "never", not be absent. "Not in the list" and "in the list, never run" read identically to
 * a person and mean opposite things, and the second is the state a newly-armed second driver is
 * in for its first quiet hour — and the state a driver that was configured and never once fired
 * stays in for ever.
 */
export async function alertDriverStatuses(db: Tx): Promise<AlertDriverStatus[]> {
  const rows = await db
    .select({
      driver: alertPassRuns.driver,
      ranAt: alertPassRuns.ranAt,
      firing: alertPassRuns.firing,
      delivered: alertPassRuns.delivered,
      failedSinks: alertPassRuns.failedSinks,
      sinksConfigured: alertPassRuns.sinksConfigured,
      sinkFailureStreak: alertPassRuns.sinkFailureStreak,
    })
    .from(alertPassRuns);
  const byDriver = new Map(rows.map((r) => [r.driver, r]));
  const drivers: readonly AlertDriver[] = ["worker", "api"];
  return drivers.map((driver) => {
    const r = byDriver.get(driver);
    return {
      driver,
      ranAt: r ? new Date(r.ranAt as unknown as string) : null,
      firing: Number(r?.firing ?? 0),
      delivered: Number(r?.delivered ?? 0),
      failedSinks: Number(r?.failedSinks ?? 0),
      sinkFailureStreak: Number(r?.sinkFailureStreak ?? 0),
      sinksConfigured: Number(r?.sinksConfigured ?? 0),
    };
  });
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
  /**
   * When this process's classifier circuit FIRST opened in its current unbroken run of trips, or
   * null while it is closed. The worker computes it from its own in-process breaker; it is the
   * only route by which `ai_provider_down` can see that mail is being filed rules-only.
   */
  aiCircuitOpenSince: Date | null;
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
      // A row that did not exist has no earlier stamp to preserve, so the INSERT branch is the
      // simple half. The `onConflictDoUpdate` below carries the case that matters.
      degradedSince: input.degraded ? now : null,
      aiCircuitOpenSince: input.aiCircuitOpenSince,
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
        // ── THE DEGRADED CLOCK, COMPUTED IN SQL AGAINST THE ROW THAT IS ALREADY THERE ──────
        //
        // Three cases in one expression, and the middle one is why this cannot be done in the
        // worker: healthy clears the stamp; degraded with NO stamp starts it at this beat;
        // degraded with a stamp LEAVES IT ALONE. The third case is what survives a leader
        // change — the incoming instance writes this row for the same shard, finds the previous
        // leader's stamp and keeps it, so a fault that outlives the process which first saw it
        // keeps its true age. An in-memory clock would restart on every deploy, and a rule that
        // fires after ten minutes would then never fire on a worker that restarts more often
        // than that.
        degradedSince: sql`case
          when ${input.degraded} is not true then null
          when ${workerHeartbeats.degradedSince} is null then ${now.toISOString()}::timestamptz
          else ${workerHeartbeats.degradedSince} end`,
        aiCircuitOpenSince: input.aiCircuitOpenSince,
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
      // The same three-case expression as the claiming write, and it has to be here too: a
      // leader draining one long first sync refreshes for minutes without ever reaching the
      // serial-queue write, so a fault that begins inside that window would otherwise go
      // unstamped for as long as it lasts — which is exactly the window the rule cares about.
      degradedSince: sql`case
        when ${input.degraded} is not true then null
        when ${workerHeartbeats.degradedSince} is null then ${now.toISOString()}::timestamptz
        else ${workerHeartbeats.degradedSince} end`,
      aiCircuitOpenSince: input.aiCircuitOpenSince,
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
  cls: AlertClass; affectedAccounts: number | null; fixHref: string | null;
  /** What the rule said. NULL only for a row written before these columns existed. */
  title: string | null; count: number | null;
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
      // The three columns the split renders (cloud 0030). Each is on the staff allowlist by
      // name, and this projection is still explicit for the reason the header gives — a column
      // added to `alert_state` must not cross the boundary just by existing.
      cls: alertState.cls,
      affectedAccounts: alertState.affectedAccounts,
      fixHref: alertState.fixHref,
      title: alertState.title,
      count: alertState.count,
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
    // A row written before 0030 has the column's DEFAULT, not NULL, so this coalesce is for a
    // hand-inserted row and for PGlite fixtures rather than for a migration window. It falls to
    // `"incident"` on {@link AlertClass}'s rule: an unclassified row is one that pages.
    cls: r.cls === "signal" ? "signal" : "incident",
    affectedAccounts: r.affectedAccounts === null ? null : Number(r.affectedAccounts),
    fixHref: r.fixHref,
    title: r.title,
    count: r.count === null ? null : Number(r.count),
  }));
}
