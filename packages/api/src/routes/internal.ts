import {
  billingReconciliationRuns, isSuspended, runAlertPass, listOpenAlerts, newDeliveryStreak,
  sinkHealthOf,
  type AlertSink,
} from "@trafficflow/db/cloud";
import { sql } from "drizzle-orm";
import { silentLogger, type Logger } from "@trafficflow/core";
import type { Tx } from "@trafficflow/db";
import {
  reapStaleWebSessions, reconcileBillingMirror, recordReconcileFailure, type AdminDb,
} from "@trafficflow/services";
import { runScheduledSendPass, runSendReconcilePass, ServiceError } from "@trafficflow/services";
import type { SendAdapter } from "@trafficflow/core/mail";
import { presentsSecret, secretRouteJson as json } from "../secret-auth.js";
import { makeSendAdapter } from "../send-adapter.js";
import { MAX_IMAP_PER_MAILBOX } from "../attachments-adapter.js";
import { imapAdmission } from "./shared.js";
import type { AlertsConfig } from "../deps-cloud.js";
import type { AlertArmHealth, AlertSinkSummary, ApiDeps } from "../deps.js";
import type {} from "../deps-cloud.js";
import type { Route } from "../router.js";
import { learnMissingSmtpSizes } from "../smtp-size.js";

/**
 * `POST /internal/alerts` — the OUTSIDE-THE-WORKER alert driver.
 *
 * ## Why this endpoint exists at all
 *
 * The worker runs the same alert pass every minute, and for three of the four rules that is
 * enough. It cannot run the fourth. "No leader lock held for > 2 minutes" is a statement
 * ABOUT the worker, and a dead process reports nothing — so the rule needs an observer on a
 * different machine, on a different platform, with a different failure mode. That is this
 * host: the API deployment watching the worker from a different platform, both reading one
 * Postgres.
 *
 * The remaining hole — every platform down at once — is covered by the scheduler itself:
 * `.github/workflows/alerts.yml` runs on GitHub's infrastructure, and a failed scheduled
 * workflow mails the repository owner without anything in this repo having to work.
 *
 * ## TWO clocks drive this host, and the reason is an outage
 *
 * The worker once died and stayed dead for over two hours with nobody notified.
 * Everything in this file was already written and correct; none of it was running, because
 * the API host had never been deployed with a secret and the only scheduler was a GitHub
 * workflow that exits 0 when its secrets are unset. So there are now two clocks:
 *
 *  · **Vercel Cron** — `GET /internal/alerts/run` below, scheduled from the host
 *    deployment's cron config. The PRIMARY, because it is the tighter interval and
 *    because it cannot be switched off by inactivity.
 *  · **GitHub Actions** — `POST /internal/alerts`, every 5 minutes. The OUTER RING, and the
 *    only observer on a third platform: when this host is the thing
 *    that is down, its `curl` fails, the run goes red, and GitHub mails the operator.
 *
 * They are not redundant with each other. Vercel Cron cannot report that Vercel is down, and
 * GitHub's schedule is best-effort and is disabled automatically after 60 days of repository
 * inactivity. Each covers the other's blind spot.
 *
 * The corresponding arming rule lives in the host deployment's build config
 * (`assertAlertingArmed`): a production build of this host with no secret and no sink does
 * not exist, so "deployed but not watching" is not a reachable state.
 *
 * ## Authentication is a shared secret, and that is the right shape
 *
 * The caller is a cron, not a person. There is no session to resolve, no cookie, no
 * step-up, and inventing a service account would mean a credential in `users` that can be
 * phished. `Authorization: Bearer <TF_ALERT_SECRET>` compared in CONSTANT TIME is the whole
 * story, and the route is `public` + `anonymous` so `withSession` never runs.
 *
 * With no `deps.alerts` the route answers **404**, not 401: a deployment that configured no
 * secret has no alerting surface, and advertising an endpoint it cannot authenticate is
 * strictly worse than not having one.
 *
 * ## Why POST and not GET
 *
 * It has side effects — it writes `alert_state` and it can send mail. A GET that mails people
 * is a GET a link preview, a crawler, or a browser prefetch can fire. `withRequestGuard` also
 * applies its content-type and cross-site checks to unsafe methods only, so POST is the
 * method that actually gets guarded.
 *
 * ## The response is the SAME data the admin console renders
 *
 * `evaluateAlerts` is a pure read shared by both, so what a scheduler sees and what an
 * operator sees cannot drift. Nothing in the body can carry mail content: every field is a
 * count, an age, or a rule name (`packages/db/src/alerts.ts`).
 *
 * ## THE ALERT PASS RUNS ENTIRELY ON THE CONTENT-BLIND CONNECTION
 *
 * `/internal/alerts*` is a STAFF SURFACE — the same audience, the same shared-secret shape and
 * the same cross-account reach as `/admin/*` — so it reads and writes through `deps.adminDb`,
 * the handle authenticated as `ohmail_admin`. That role holds SELECT on the four rules' inputs
 * (`worker_heartbeats`, `billing_events`, `outbound_sends`, `mailboxes`,
 * `billing_subscriptions`) and it is the ONE table this role writes: `alert_state`, which it
 * may INSERT, UPDATE and DELETE because the pass opens a row, claims the notification and
 * deletes the row when the condition clears.
 *
 * **The one thing that is NOT on the blind handle, stated because the sentence above used to
 * claim otherwise.** The mail SINK — the second delivery path, not the pass — claims a
 * slot in the per-recipient limiter, and `auth_throttle` is a table `ohmail_admin` has no grant
 * on. It therefore holds a narrow limiter port over the runtime connection, built in the host's
 * composition root (`apps/api-vercel/src/deps.ts`), and never a `Db`: see
 * `packages/services/src/mail/mail-service.ts:RecipientLimiter`. Before that correction it held
 * `makePooledDb(...) as never`, which made "all three routes run wholly on the blind
 * connection" false.
 *
 * ## A DARK PAGER ANSWERS 503, AND AN ABSENT ONE ANSWERS 404
 *
 * With no `deps.alerts` this host has no alerting surface and every route here is **404**: a
 * deployment that configured no secret is not broken, it simply has no pager, and advertising
 * an endpoint it cannot authenticate is worse than not having one.
 *
 * With `deps.alerts` armed and no `deps.adminDb` the pager is CONFIGURED AND CANNOT RUN, and
 * that is **503 `alerts_db_unarmed`**. The two must not share an answer. A dead-man's switch
 * that 404s is indistinguishable from one nobody asked for, and this exact state — alerting
 * fully configured, no blind handle, `/health` still 200 — was reachable for a while because
 * `loadAdminConfig` refused on `TF_ADMIN_SECRET` before it ever looked at `DATABASE_URL_ADMIN`.
 * The construction of the pager's database handle was gated on the admin console's credential.
 * It is not any more (`loadStaffDbConfig`), and `/health` publishes `alertsFault` so an operator
 * gets the reason in one curl.
 *
 * Both answers are non-2xx, so the third ring catches either: `.github/workflows/alerts.yml`
 * curls `POST /internal/alerts` every five minutes from GitHub's infrastructure, the run goes
 * red, and GitHub mails the operator without anything in this repo having to work.
 *
 * The alternative — falling back to `deps.db` when the blind handle is absent — is the "absent
 * configuration selects the dangerous branch" shape this whole surface exists to remove.
 */

/*
 * `secretMatches` / `bearerOf` / the `no-store` JSON helper moved to `../secret-auth.js` when
 * `routes/admin.ts` became the second shared-secret caller. See that file for why a second
 * copy was the thing to avoid.
 */

/**
 * The PATH Vercel Cron is pointed at. Exported because the host deployment's cron config names
 * it as a literal string and a test asserts the two agree — a cron whose path this router does
 * not serve is a dead-man's switch that answers 404 to its own clock, which is precisely the
 * "configured, and silently not running" state the whole slice exists to make impossible.
 */
export const ALERT_CRON_PATH = "/internal/alerts/run";

/**
 * The PATH the session reaper is scheduled at — exported for the same reason
 * {@link ALERT_CRON_PATH} is: the scheduler names it as a literal string and a test asserts
 * the two agree, because a schedule whose path this router does not serve is hygiene that
 * "shipped" and silently never runs. The scheduler is the always-on WORKER
 * (`apps/worker/src/api-cron.ts`, daily), not the host deployment's platform cron: that
 * layer was measured dark for three weeks of deploys on 2026-08-22 — entries configured,
 * never registered, nothing logged — and the same census now matches the worker's table.
 */
export const SESSIONS_REAP_CRON_PATH = "/internal/sessions/reap";

/**
 * The PATH the `SIZE` back-fill is scheduled at — exported for the reason the two above it
 * are: the scheduler names it as a literal string and a test asserts the two agree, because a
 * schedule whose path this router does not serve is hygiene that "shipped" and silently never
 * runs. Driven by the worker's `api-cron.ts` (daily), for the reason on
 * {@link SESSIONS_REAP_CRON_PATH}; the PASS still runs here, on the API host, whose SMTP
 * egress works — only the clock moved.
 */
export const SMTP_SIZE_CRON_PATH = "/internal/mailboxes/smtp-size";

/**
 * The PATH the billing reconciliation is scheduled at — the ARMED pass, exported for the
 * reason its three siblings are: the scheduler names it as a literal string and a test asserts
 * the two agree. Driven HOURLY by the worker's `api-cron.ts` (the reason is on
 * {@link SESSIONS_REAP_CRON_PATH}); `billing_reconciliation_stale` (6 h) is the net under that
 * clock. The read-only twin (`GET /internal/billing/reconcile`, dry-run) is the runbook's safe
 * curl — it compares and reports but applies nothing, exactly as `GET /internal/alerts` reads
 * without paging.
 */
export const BILLING_RECONCILE_CRON_PATH = "/internal/billing/reconcile/run";

/**
 * The PATH the SCHEDULED-SEND pass is scheduled at (Send later, mail 0077) — exported for the
 * reason its four siblings are: the worker's `api-cron.ts` names it as a literal string and a
 * census asserts the two agree, because a schedule whose path this router does not serve is a
 * feature whose whole promise ("it sends at 9:00") silently never runs. Poked EVERY MINUTE —
 * the appointment's stated precision is "±about a minute", so the clock has to be at least
 * that fine. The PASS runs here, on the API host, and that placement is measured twice over:
 * the sync host's platform blocks outbound SMTP submission at the port level
 * (`apps/worker/src/smtp-size.ts`), and the worker's runtime dependency set may not include
 * `@trafficflow/services` (its package.json records the Node-23 boot crash that promoting it
 * caused) — while this host runs `SendService` on every manual send already.
 */
export const SCHEDULED_SEND_CRON_PATH = "/internal/sends/scheduled/run";

/**
 * `GET /internal/sends/reconcile/run` — the RECONCILING pass for stranded send reservations.
 *
 * A SEPARATE route from the sender's clock one line up, and the separation is a budget rather
 * than a preference: that invocation already plans three sends of up to twenty seconds each
 * against this platform's sixty-second kill, so hanging a second batch of work off it would
 * spend the sender's remaining time on the reconciler's. Both are poked every minute by the same
 * worker clock, on their own staggers.
 *
 * `runSendReconcilePass` holds the whole policy — what "stranded" means, which mailboxes may be
 * dialled, and why nothing on this path can submit.
 */
export const SEND_RECONCILE_CRON_PATH = "/internal/sends/reconcile/run";

/**
 * `makeSendAdapter` UNDER THE PER-MAILBOX IMAP ADMISSION COUNTER — the reconciling pass's dial.
 *
 * The attachment path's `openImapUnderCap` shape, reduced to the half this caller needs: acquire
 * before the credential is decrypted and long before a socket exists, release exactly once when
 * the handle closes. There is no local in-process slot here because there is no queue to hold
 * one — a refusal is a defer, and the row is examined again a minute later.
 *
 * A REFUSAL IS A `ServiceError`, deliberately: that is what the pass's resolver reads as "this
 * mailbox cannot be dialled", which defers the row instead of writing a terminal state off a
 * dial that never happened. A counter that THREW (a database fault, not a refusal) propagates,
 * because failing open here would be a mailbox dialled without admission — the exact state the
 * counter exists to prevent.
 *
 * The release is best-effort and never silent: losing it leaves the mailbox one unit short until
 * the stale-window reclaim resets it, which is the bounded direction; throwing would replace a
 * completed probe with an error about our own bookkeeping.
 */
async function admittedSendAdapter(deps: ApiDeps, mailboxId: string): Promise<SendAdapter> {
  const now = (): Date => deps.now?.() ?? new Date();
  const admitted = await imapAdmission(deps).acquire(
    deps.db, { mailboxId, max: MAX_IMAP_PER_MAILBOX, now: now() },
  );
  if (!admitted) {
    throw new ServiceError(
      "mailbox_busy", 429,
      "this mailbox is at its connection ceiling; the reservation is examined again next cycle",
    );
  }
  let released = false;
  const release = async (): Promise<void> => {
    if (released) return;
    released = true;
    try {
      await imapAdmission(deps).release(deps.db, mailboxId, now());
    } catch (err) {
      deps.logger?.warn?.("imap_slot_release_failed", { mailboxId, err: String(err) });
    }
  };

  let adapter: SendAdapter;
  try {
    adapter = await makeSendAdapter(deps, mailboxId);
  } catch (err) {
    // The slot must go back or this instance leaks it until the stale-window reclaim.
    await release();
    throw err;
  }
  return {
    send: (msg) => adapter.send(msg),
    messageInSent: (messageId) => adapter.messageInSent(messageId),
    close: async () => {
      try {
        await adapter.close();
      } finally {
        await release();
      }
    },
  };
}

/** class + code, never message text — the same scrubbing rule as `billing_events.error`. */
function scrubError(err: unknown): string {
  const e = err as { name?: unknown; code?: unknown; constructor?: { name?: string } } | null;
  const cls = typeof e?.name === "string" ? e.name : e?.constructor?.name ?? "unknown";
  const code = typeof e?.code === "string" ? e.code : null;
  return code ? `${cls}:${code}` : cls;
}

/**
 * The two arming facts, in ONE place, because the three routes must never disagree about them.
 *
 * `armed: false` carries the response rather than a reason, so a caller cannot accidentally
 * turn "the pager is broken" into "the pager was never here" by picking its own status. The two
 * answers are the whole point — see the header.
 */
type AlertGate =
  | { armed: true; cfg: AlertsConfig; staff: () => Promise<AdminDb> }
  | { armed: false; res: Response };

function alertsArmed(
  cfg: AlertsConfig | undefined, staff: (() => Promise<AdminDb>) | undefined,
): AlertGate {
  // No secret ⇒ no alerting surface on this deployment. 404, deliberately, not 401.
  if (!cfg || cfg.secret.trim().length === 0) {
    return { armed: false, res: json(404, { error: { code: "not_found" } }) };
  }
  // Configured, and no content-blind connection to run on. 503 — and it is answered BEFORE
  // authentication on purpose: `/health` already publishes `alertsFault` to anyone who asks, so
  // there is nothing here a 401 would keep back, and both schedulers must see the fault even if
  // the credential they hold has also drifted.
  if (!staff) {
    return { armed: false, res: json(503, { error: { code: "alerts_db_unarmed" } }) };
  }
  return { armed: true, cfg, staff };
}

/**
 * Run one pass and answer it, shared by all three drivers.
 *
 * One implementation, three callers (the GitHub POST, the Vercel Cron GET, and any operator
 * with curl), because two copies of the logging block is where the two surfaces drift and an
 * incident gets logged differently depending on which clock happened to observe it.
 *
 * **It takes four narrow values and not `ApiDeps`.** This runs behind a staff
 * credential with cross-account reach, and it needed exactly `deps.logger` and `deps.now` out
 * of that container — so those are what it gets. Handing it the whole bag would have handed it
 * `deps.db`, the user-serving runtime connection, which is the capability `/admin/*` just
 * finished removing from its own callbacks. `route` is gone with it: the caller already builds
 * the child logger it was used for.
 */
/**
 * This host's consecutive-failure memory for the alert sinks.
 *
 * MODULE SCOPE, and honest about what that buys on a serverless host: it accumulates only for
 * as long as one instance stays warm, so this driver escalates a persistently-refusing sink
 * less reliably than the worker does — the worker runs a pass every 60 s in one long-lived
 * process and is where that alarm is load-bearing. Here it is a second chance at the same
 * signal, and it is free. See `DeliveryStreak` for why this is not a table.
 */
const apiDeliveryStreak = newDeliveryStreak();

/**
 * How many passes THIS INSTANCE has completed, and the only reason it is counted.
 *
 * `apiDeliveryStreak` above accumulates for as long as one instance stays warm, so a cold
 * instance answers `attempts: 0` for every arm — including arms that have been delivering for
 * months. Published on `/health` with nothing beside it, those zeros read as "the pager has
 * never worked", which is a lie in the direction that endpoint may never lie in. This number is
 * the qualifier: `passes: 0` says the counters are cold, `passes: 40` with `attempts: 0` says
 * this instance ran forty passes and had nothing to page about.
 *
 * Incremented the moment a pass CAN mutate the streak — see the comment at the increment for why
 * "completed" was the wrong line to draw and how a post-delivery database failure would otherwise
 * leave warm counters labelled cold.
 */
let apiAlertPasses = 0;

/**
 * The pager's standing health as `GET /health` publishes it — the ONE reader of the streak above
 * that is not the pass itself.
 *
 * It exists because the worker's boot announcement has no equivalent on a serverless host: the
 * worker names its arms in its startup line and warns when there is exactly one, and until this
 * function the per-arm verdicts here lived only on the `/internal/alerts` response, behind the
 * scheduler's credential. This host is the only observer of a dead worker, so its own arms going
 * quiet is precisely the fault that coincides with the outage they exist to report.
 *
 * DERIVED, never stored, for the reason the worker's `/health` gives about `sinkHealthOf`: a
 * cached copy would drift from the streak the pass actually mutates. It reads memory only, so
 * `/health` still touches no database — which for this field is the whole point, since one of the
 * states it has to be readable in is the one where the database cannot be read.
 *
 * The return type is the MAIL-half `AlertSinkSummary`, and the projection is written out field by
 * field on purpose. `AlertSinkHealth` is a hosted type that `/health`'s own module may not name,
 * so the two shapes are mirrors — and structural assignability would happily accept a wider
 * object, while `JSON.stringify` publishes what an object holds rather than what its type says.
 * Naming every field is what makes a later addition to `AlertSinkHealth` — a vendor's error
 * sentence being the candidate that matters — a compile error here instead of new text on an
 * endpoint anybody can read.
 */
export function apiAlertSinkSummary(sinks: readonly AlertSink[]): AlertSinkSummary {
  return {
    arms: sinkHealthOf(sinks, apiDeliveryStreak).map((arm): AlertArmHealth => ({
      name: arm.name,
      outcome: arm.outcome,
      consecutiveFailures: arm.consecutiveFailures,
      attempts: arm.attempts,
      lastOkAt: arm.lastOkAt,
    })),
    passes: apiAlertPasses,
  };
}

async function alertPass(
  cfg: AlertsConfig, log: Logger, now: () => Date, staffDb: () => Promise<AdminDb>,
): Promise<Response> {
  try {
    const staff = await staffDb();
    // COUNTED THE INSTANT THE PASS CAN TOUCH THE STREAK, and the placement is the whole
    // correctness of the field.
    //
    // It used to be counted after `runAlertPass` RETURNED, on the reasoning that a pass which
    // threw evaluated nothing. That reasoning is false in a state the design explicitly
    // supports: the streak is mutated by `deliver()` and only then are the notification claims
    // settled, so a settle UPDATE that fails throws AFTER the per-arm counters have already
    // advanced. On that path the arms would publish fresh attempts and outcomes beside
    // `passes: 0` — the qualifier claiming its own neighbours are cold, and permanently so on an
    // instance where that keeps happening. Counting on entry makes the two inseparable: every
    // invocation that CAN mutate the streak is counted, and one that cannot (no staff handle:
    // `await staffDb()` above rejects before this line) is not.
    //
    // What the number therefore means is "alert passes this instance has RUN", not "completed".
    // A pass that died before `evaluateAlerts` returned is still counted and still left the arms
    // at zero, so `passes: 40` with `attempts: 0` reads either as forty quiet passes or as forty
    // failing ones. That ambiguity is deliberate and is not this field's job: a failing pass
    // answers 503 to its scheduler and logs `alert_pass_failed`, which is where it is diagnosed.
    // The one thing the field must never do is call warm counters cold.
    apiAlertPasses++;
    const result = await runAlertPass(staff, {
      now: now(),
      sinks: cfg.sinks ?? [],
      shards: cfg.shards,
      thresholds: cfg.thresholds,
      repeatMs: cfg.repeatMs,
      source: "api",
      environment: cfg.environment ?? "production",
      deliveryStreak: apiDeliveryStreak,
    });

    for (const alert of result.firing) {
      log.warn("alert_firing", {
        alertKey: alert.key, kind: alert.kind, severity: alert.severity,
        count: alert.count, oldestSeconds: alert.oldestSeconds, detail: alert.detail,
      });
    }
    for (const key of result.resolved) log.info("alert_resolved", { alertKey: key });
    if (result.notified.length > 0) {
      log.warn("alert_notified", {
        alertKeys: result.notified.map((a) => a.key),
        delivered: result.delivered, failedSinks: result.failedSinks,
        sinkErrors: result.sinkErrors,
        sinkFailureStreak: result.sinkFailureStreak,
      });
    }
    for (const lost of result.sinkDegraded) {
      // REDUNDANCY LOST ON *THIS* HOST — and this host is the only observer of a dead worker,
      // so its arms going quiet one at a time is the version of the fault that can coincide
      // with the outage it exists to report. The worker logs the same event about the worker's
      // own arms; neither driver can see the other's, because a streak is one driver's
      // experience of one sink (`DeliveryStreak`). Without this line an arm that died HERE
      // would be silent while the worker cheerfully reported two healthy arms of its own.
      log.error("alert_sink_degraded", {
        sink: lost.sink,
        outcome: lost.outcome,
        consecutiveFailures: lost.consecutiveFailures,
        survivors: lost.survivors,
        sinkErrors: lost.error ? [`${lost.sink}: ${lost.error}`] : [],
        reason: "one alert sink has refused every delivery for a full streak while another " +
          "delivered — pages are still landing, and this host is back to a single vendor",
      });
    }
    if (result.escalate) {
      log.error("alerts_undeliverable", {
        firing: result.firing.length,
        reason: "every configured alert sink refused delivery, repeatedly — alerts are reaching nobody",
        sinks: result.escalate.sinks,
        consecutiveFailures: result.escalate.consecutiveFailures,
        sinkErrors: result.escalate.errors,
      });
    }
    if (result.firing.length > 0 && result.undeliverable) {
      log.error("alerts_undeliverable", {
        firing: result.firing.length,
        reason: "this host has no alert sink configured",
      });
    }

    // 200 even when alerts are firing: the PASS succeeded, and a scheduler that treats a
    // firing alert as its own failure would turn every real incident into two. A non-2xx
    // here means the observer is broken, which is a different thing and is what the
    // scheduler's failure notification is for.
    return json(200, {
      now: result.now,
      firing: result.firing,
      notified: result.notified.map((a) => a.key),
      resolved: result.resolved,
      delivered: result.delivered,
      failedSinks: result.failedSinks,
      // Redacted by the sink before it ever gets here — see `redactEndpoint`. An operator with
      // curl gets the same diagnosis the log line carries, without a log-drain query.
      sinkErrors: result.sinkErrors,
      sinkFailureStreak: result.sinkFailureStreak,
      undeliverable: result.undeliverable,
      // Per-arm standing health, so an operator with curl can see WHICH arm is carrying the
      // pages rather than only that something did. Closed codes and counts — the vendor's own
      // sentence is already in `sinkErrors` above, which this endpoint's credential gates.
      sinkHealth: result.sinkHealth,
    });
  } catch (err) {
    // `raw` means there is no error envelope above this handler, so it must never throw.
    log.error("alert_pass_failed", { err });
    return json(503, { error: { code: "alert_pass_failed" } });
  }
}

/**
 * One reconciliation pass, shared by the dry-run read and the armed cron — one implementation,
 * two clocks, exactly as `alertPass` is shared, and for the same drift reason.
 *
 * Never throws (`raw` routes have no error envelope). A pass that could not run records a
 * FAILED run row (class:code only) so the staleness rule sees a reconciler that is failing,
 * not a gap, and answers 503 to its scheduler.
 */
async function reconcilePass(
  req: Request, deps: ApiDeps, mode: "dry-run" | "apply", route: string,
): Promise<Response> {
  const log = (deps.logger ?? silentLogger).child({ route });
  const cfg = deps.alerts;
  // The sibling rules verbatim: no armed internal surface ⇒ 404, wrong secret ⇒ 401.
  if (!cfg || cfg.secret.trim().length === 0) {
    return json(404, { error: { code: "not_found" } });
  }
  const cron = cfg.cronSecret?.trim();
  const authorized = presentsSecret(req, cfg.secret)
    || (cron !== undefined && cron.length > 0 && presentsSecret(req, cron));
  if (!authorized) {
    log.warn("billing_reconcile_unauthorized", {});
    return json(401, { error: { code: "unauthorized" } });
  }
  const plane = deps.services?.billingPlane;
  const svc = deps.services?.entitlements;
  if (!plane || !svc) {
    // A deployment without billing has nothing to reconcile, and a cron with nothing to do did
    // not fail — a genuinely billing-free host answers 200 and writes nothing, forever.
    //
    // But a host whose RUN LEDGER HAS HISTORY is not that host: billing ran here before, and
    // "unconfigured" now is a mis-flip (an env change that dropped the plane block, a restored
    // environment). The stale rule alone cannot see the difference between "never armed" and
    // "disarmed yesterday" until its threshold passes — and on the armed CRON path a mis-flip
    // must become durable immediately, so a FAILED run row is recorded (failed rows never
    // reset the staleness clock, and the divergence trail shows the reason by name). The
    // dry-run path stays read-only: a person's curl must not write.
    if (mode === "apply") {
      try {
        const ranBefore = await (deps.db as unknown as Tx)
          .select({ n: sql`count(*)::int` })
          .from(billingReconciliationRuns).limit(1);
        const n = Number((ranBefore[0] as { n?: unknown } | undefined)?.n ?? 0);
        if (n > 0) {
          await recordReconcileFailure(deps.db, mode, "billing_unconfigured", deps.now());
          log.error("billing_reconcile_unconfigured_with_history", {
            reason: "the reconciliation ran on this deployment before, and billing is now unconfigured",
          });
        }
      } catch { /* the 200-skip is still the honest cron answer; the stale rule remains the net */ }
    }
    return json(200, { skipped: "billing_unconfigured" });
  }
  try {
    const report = await reconcileBillingMirror(deps.db, {
      mode,
      plane,
      applyEvent: (db, event) => svc.applyEvent(db, event),
      now: deps.now,
    });
    if (report.emitted > 0 || Object.keys(report.flagged).length > 0) {
      log.warn("billing_reconcile_divergence", {
        mode, emitted: report.emitted, applyFailed: report.applyFailed,
        flagged: Object.entries(report.flagged).map(([c, n]) => `${c}:${n}`).join(","),
        pages: report.pages, truncated: report.truncated,
      });
    }
    return json(200, {
      now: deps.now().toISOString(),
      mode: report.mode,
      stripeSubscriptions: report.stripeSubscriptions,
      mirrorRows: report.mirrorRows,
      emitted: report.emitted,
      applyFailed: report.applyFailed,
      flagged: report.flagged,
      divergences: report.divergences,
      pages: report.pages,
      truncated: report.truncated,
    });
  } catch (err) {
    // The pass itself could not run. Record the failure (best effort — the 503 is the
    // load-bearing part) with class:code only, never message text.
    log.error("billing_reconcile_failed", { err });
    try {
      await recordReconcileFailure(deps.db, mode, scrubError(err), deps.now());
    } catch { /* the 503 already says it; a second failure must not mask the first */ }
    return json(503, { error: { code: "reconcile_failed" } });
  }
}

export const internalRoutes: Route[] = [
  {
    method: "POST",
    pattern: "/internal/alerts",
    // `unauthenticated`: the caller is a scheduler holding a shared secret, not an
    // account, and `anonymous` means no session is ever resolved for `withSpendGate` to judge.
    cost: "unauthenticated",
    // `public` (a cron holds no session) + `anonymous` (do not resolve one either: a stray
    // ambient cookie must not cost a `sessions` query on a path that runs every 5 minutes).
    options: { public: true, anonymous: true, raw: true },
    handler: async (req, deps) => {
      const log = (deps.logger ?? silentLogger).child({ route: "/internal/alerts" });
      const gate = alertsArmed(deps.alerts, deps.adminDb);
      if (!gate.armed) return gate.res;

      if (!presentsSecret(req, gate.cfg.secret)) {
        log.warn("alerts_unauthorized", {});
        return json(401, { error: { code: "unauthorized" } });
      }
      return alertPass(gate.cfg, log, deps.now, gate.staff);
    },
  },
  {
    /**
     * `GET /internal/alerts/run` — THE PLATFORM CRON'S ENTRY POINT, and the reason the dead
     * worker of the outage above would be paged for today.
     *
     * ## Why a second path, and why GET
     *
     * The POST above is the right shape for a caller that can choose its method, and the
     * header explains at length why a pass that writes `alert_state` and can send mail should
     * not be a GET. Vercel Cron cannot choose: it issues GET, and only GET. The options were a
     * GET with side effects or no platform cron at all, and "no platform cron" leaves the only
     * external clock on GitHub Actions — best-effort, and DISABLED AUTOMATICALLY after 60 days
     * of repository inactivity. A dead-man's switch with an expiry date is the failure this
     * endpoint exists to prevent, wearing a different hat.
     *
     * The POST's actual objection survives intact, because it was never about the verb: it was
     * that a GET which mails people can be fired by a link preview, a crawler or a browser
     * prefetch. None of those can present a bearer token. An unauthenticated GET here is a
     * 401, and nothing runs.
     *
     * It is a SEPARATE path from `GET /internal/alerts` rather than a mode of it, because that
     * one is documented as the runbook's safe read — "is anything paging right now?" — and
     * the operations runbook tells an operator to curl it. Overloading it would mean the
     * documented diagnostic command stamps `notified_at` and pages people.
     *
     * ## Two accepted secrets
     *
     * `TF_ALERT_SECRET` (the same credential the other two drivers hold) or `CRON_SECRET`
     * (Vercel's own, which the platform presents on cron invocations). Both constant-time.
     * See {@link AlertsConfig.cronSecret} for why this is two credentials and not one value
     * pasted twice.
     */
    method: "GET",
    pattern: ALERT_CRON_PATH,
    cost: "unauthenticated",
    options: { public: true, anonymous: true, raw: true },
    handler: async (req, deps) => {
      const log = (deps.logger ?? silentLogger).child({ route: ALERT_CRON_PATH });
      const gate = alertsArmed(deps.alerts, deps.adminDb);
      if (!gate.armed) return gate.res;

      const cron = gate.cfg.cronSecret?.trim();
      const authorized = presentsSecret(req, gate.cfg.secret)
        || (cron !== undefined && cron.length > 0 && presentsSecret(req, cron));
      if (!authorized) {
        log.warn("alerts_unauthorized", {});
        return json(401, { error: { code: "unauthorized" } });
      }
      return alertPass(gate.cfg, log, deps.now, gate.staff);
    },
  },
  {
    /**
     * `GET /internal/alerts` — READ-ONLY. What is currently open, without evaluating or
     * notifying anything. The operator's "is something paging right now?" and the thing a
     * runbook can safely curl without stamping `notified_at`.
     */
    method: "GET",
    pattern: "/internal/alerts",
    cost: "unauthenticated",
    options: { public: true, anonymous: true, raw: true },
    handler: async (req, deps) => {
      const gate = alertsArmed(deps.alerts, deps.adminDb);
      if (!gate.armed) return gate.res;
      if (!presentsSecret(req, gate.cfg.secret)) {
        return json(401, { error: { code: "unauthorized" } });
      }
      try {
        const open = await listOpenAlerts(await gate.staff());
        return json(200, { now: deps.now().toISOString(), open });
      } catch {
        return json(503, { error: { code: "alert_read_failed" } });
      }
    },
  },
  {
    /**
     * `GET /internal/sessions/reap` — THE WEB-SESSION REAPER'S CLOCK. Revokes plain browser
     * sessions (`device_id IS NULL`, scope `full`) unseen for over sixty days, refresh
     * families included; paired devices are structurally out of reach
     * (`reapStaleWebSessions`, where the whole policy is argued). Without this pass a
     * session that stops being presented simply stops rolling and sits live-but-idle for
     * ever — the flood the Devices pane showed its owner.
     *
     * The alert cron's shape verbatim, and each borrowed property is load-bearing:
     *  · **GET, because Vercel Cron issues GET and only GET** — the same trade the alerts
     *    run makes, and the same defense: a link preview or a crawler cannot present a
     *    bearer token, and an unauthenticated GET here is a 401 that reaps nothing.
     *  · **Two accepted secrets** — `TF_ALERT_SECRET` (the operator's own driver) or
     *    `CRON_SECRET` (what the platform presents on cron invocations), both constant-time.
     *  · **No secret configured ⇒ 404** — a deployment that armed no internal surface has no
     *    reaper, and advertising an endpoint it cannot authenticate is worse than not having
     *    one. (Consequence, named because the ruling named it: on such a deployment the
     *    hygiene DOES NOT RUN. The live acceptance curls the armed route and reads a count.)
     *
     * It runs on `deps.db`, the RUNTIME connection, and NOT the content-blind staff handle —
     * the opposite choice from every alert route above, argued rather than inherited:
     * revoking sessions is session machinery on user tables (`sessions`,
     * `refresh_tokens`), a write grant `ohmail_admin` does not hold and must not gain. The
     * shared secret gates WHO can fire the pass; what the pass may touch is pinned by the
     * reaper's own structural predicate.
     */
    method: "GET",
    pattern: SESSIONS_REAP_CRON_PATH,
    cost: "unauthenticated",
    options: { public: true, anonymous: true, raw: true },
    handler: async (req, deps) => {
      const log = (deps.logger ?? silentLogger).child({ route: SESSIONS_REAP_CRON_PATH });
      const cfg = deps.alerts;
      if (!cfg || cfg.secret.trim().length === 0) {
        return json(404, { error: { code: "not_found" } });
      }
      const cron = cfg.cronSecret?.trim();
      const authorized = presentsSecret(req, cfg.secret)
        || (cron !== undefined && cron.length > 0 && presentsSecret(req, cron));
      if (!authorized) {
        log.warn("sessions_reap_unauthorized", {});
        return json(401, { error: { code: "unauthorized" } });
      }
      try {
        const result = await reapStaleWebSessions(deps.db as unknown as Tx, deps.now());
        if (result.reaped > 0) log.info("sessions_reaped", { reaped: result.reaped });
        return json(200, { now: deps.now().toISOString(), reaped: result.reaped });
      } catch (err) {
        // `raw` means no error envelope above this handler; it must never throw.
        log.error("sessions_reap_failed", { err });
        return json(503, { error: { code: "sessions_reap_failed" } });
      }
    },
  },
  {
    /**
     * `GET /internal/mailboxes/smtp-size` — LEARN WHAT EXISTING MAILBOXES' SERVERS ACCEPT.
     *
     * `mailboxes.smtp_max_size_bytes` is the only ceiling left on an attachment once the bytes stop
     * riding the send request, and nothing ever learned it for a mailbox that was already
     * connected: the column is written on create and on a PATCH that re-dials SMTP, which means the
     * person re-entering their password. This pass closes that, a bounded batch at a time —
     * `learnMissingSmtpSizes` holds the whole policy, including why it runs on THIS host and not on
     * the sync worker (the platform there blocks outbound submission ports; measured, not assumed).
     *
     * The session reaper's shape verbatim, and each borrowed property is load-bearing for the same
     * reasons stated there: GET because Vercel Cron issues GET; either shared secret, compared in
     * constant time; and 404 rather than 401 on a deployment that armed no internal surface —
     * which does mean the back-fill DOES NOT RUN there, and such a deployment's mailboxes keep the
     * strict fallback until somebody re-enters a password.
     *
     * It runs on `deps.db`, the runtime connection, for the reaper's reason: this reads
     * `mailbox_credentials` and writes `mailboxes`, which is user-table machinery the content-blind
     * staff handle does not hold and must not gain.
     *
     * `cost: "unauthenticated"` like its two siblings — the shared secret is the whole gate, no
     * user session is resolved, and the spend census counts it in the unauthenticated class rather
     * than in the gated remainder. It DOES open sockets to third-party servers, which is why the
     * batch and the deadline are constants in `smtp-size.ts` rather than parameters a caller picks.
     */
    method: "GET",
    pattern: SMTP_SIZE_CRON_PATH,
    cost: "unauthenticated",
    options: { public: true, anonymous: true, raw: true },
    handler: async (req, deps) => {
      const log = (deps.logger ?? silentLogger).child({ route: SMTP_SIZE_CRON_PATH });
      const cfg = deps.alerts;
      if (!cfg || cfg.secret.trim().length === 0) {
        return json(404, { error: { code: "not_found" } });
      }
      const cron = cfg.cronSecret?.trim();
      const authorized = presentsSecret(req, cfg.secret)
        || (cron !== undefined && cron.length > 0 && presentsSecret(req, cron));
      if (!authorized) {
        log.warn("smtp_size_unauthorized", {});
        return json(401, { error: { code: "unauthorized" } });
      }
      try {
        const result = await learnMissingSmtpSizes({ ...deps, logger: log });
        if (result.learned > 0) log.info("smtp_size_pass", { ...result });
        return json(200, { now: deps.now().toISOString(), ...result });
      } catch (err) {
        // `raw` means no error envelope above this handler; it must never throw.
        log.error("smtp_size_pass_failed", { err });
        return json(503, { error: { code: "smtp_size_pass_failed" } });
      }
    },
  },
  /*
   * THE BILLING RECONCILIATION — two routes, the alerts pattern verbatim (a safe read and an
   * armed clock), because the thing being guarded is money state.
   *
   * `GET /internal/billing/reconcile` is the DRY RUN: it pages the plane's `status:"all"`
   * subscription list, compares every subscription against the `billing_subscriptions` mirror,
   * and reports what an armed pass WOULD re-emit — codes, Stripe ids, account ids, nothing
   * else — applying nothing. The runbook's first command after any webhook incident, and the
   * read this slice's production bring-up ran before arming anything.
   *
   * `GET /internal/billing/reconcile/run` is the ARMED pass Vercel Cron fires hourly: the same
   * comparison, and each divergence is re-emitted through `EntitlementsService.applyEvent` —
   * the SAME claim+apply transaction the webhook relay calls, so there is no second write path
   * into the mirror (replay semantics — the license boundary keeps every write open-side).
   * Both record their run in
   * `billing_reconciliation_runs`, which the two reconciliation alert rules read.
   *
   * Shape borrowed from the three siblings above, each property load-bearing for their stated
   * reasons: GET because Vercel Cron issues GET; either shared secret, constant-time; 404 on a
   * deployment that armed no internal surface. Two departures, both argued:
   *  · with alerts armed but billing unconfigured (no plane, no entitlements service) the
   *    answer is 200 `{skipped:"billing_unconfigured"}`, not 5xx — a cron with nothing to do
   *    did not fail, and a self-hosted deployment without billing must not record red cron
   *    runs forever. On OUR production the quiet-branch tripwire is the `billing_reconciliation_stale`
   *    alert: skipped passes insert no run row, so a mis-flip goes stale and pages.
   *  · it runs on `deps.db`, the RUNTIME connection, for the reaper's reason: applyEvent
   *    writes billing tables and the ledger, grants `ohmail_admin` does not hold and must not
   *    gain.
   */
  {
    /**
     * `GET /internal/sends/scheduled/run` — SEND LATER's sender pass (mail 0077).
     *
     * Claims due `drafts.send_at` appointments and runs the ordinary gated send on each with
     * the row's own stored Idempotency-Key — `runScheduledSendPass` holds the whole policy
     * (the claim, the recovery arm, the outcome table, and why the pass runs on THIS host and
     * not the sync worker). The session reaper's shape verbatim, each borrowed property
     * load-bearing for the reasons stated there: GET, either shared secret in constant time,
     * 404 on a deployment that armed no internal surface — which does mean scheduled sends DO
     * NOT FIRE there, and that is the honest state of a host nobody armed a clock on.
     *
     * It runs on `deps.db`, the runtime connection, for the reaper's reason: this reads and
     * writes `drafts`/`outbound_sends` and dials the user's own mail servers through their
     * decrypted credentials — user-table machinery the content-blind staff handle does not
     * hold and must not gain.
     *
     * Overlapping pokes are SAFE here in a way the reconciler's are not: the claim is
     * `FOR UPDATE SKIP LOCKED` and every send is idempotency-keyed, so two invocations split
     * the due set rather than double-sending — the property the whole pass is built on.
     */
    method: "GET",
    pattern: SCHEDULED_SEND_CRON_PATH,
    cost: "unauthenticated",
    options: { public: true, anonymous: true, raw: true },
    handler: async (req, deps) => {
      const log = (deps.logger ?? silentLogger).child({ route: SCHEDULED_SEND_CRON_PATH });
      const cfg = deps.alerts;
      if (!cfg || cfg.secret.trim().length === 0) {
        return json(404, { error: { code: "not_found" } });
      }
      const cron = cfg.cronSecret?.trim();
      const authorized = presentsSecret(req, cfg.secret)
        || (cron !== undefined && cron.length > 0 && presentsSecret(req, cron));
      if (!authorized) {
        log.warn("scheduled_send_unauthorized", {});
        return json(401, { error: { code: "unauthorized" } });
      }
      try {
        const result = await runScheduledSendPass(deps.db, {
          openSendAdapter: deps.services?.sendAdapter
            ?? ((mailboxId: string) => makeSendAdapter(deps, mailboxId)),
          ...(deps.services?.storageCapOf ? { resolveStorageCap: deps.services.storageCapOf } : {}),
          // THE SUSPENSION GATE, injected here because the fact is the cloud half's
          // (`account_suspensions`) and the pass ships in the desktop engine bundle, which may
          // not name a cloud table. A suspended account's automation must not keep firing —
          // the worker's roster makes the same ruling — so its due appointments stay
          // `'scheduled'`, undialled, until the suspension lifts. The read runs on the HANDED
          // handle (the claim transaction's own), never `deps.db`: on this host's pooled
          // connection the captured form queued behind the transaction holding it and every
          // poke timed out — the deadlock rule on `ScheduledSendPassDeps.accountEligible`.
          accountEligible: async (accountId, handle) =>
            !(await isSuspended(handle as unknown as Tx, accountId)),
          log,
          now: deps.now,
        });
        if (result.claimed > 0) log.info("scheduled_send_pass", { ...result });
        return json(200, { now: deps.now().toISOString(), ...result });
      } catch (err) {
        // `raw` means no error envelope above this handler; it must never throw. Per-row
        // faults are already absorbed inside the pass — this catches only the claim itself.
        log.error("scheduled_send_pass_failed", { err });
        return json(503, { error: { code: "scheduled_send_pass_failed" } });
      }
    },
  },
  {
    /**
     * `GET /internal/sends/reconcile/run` — the reconciler for stranded send RESERVATIONS.
     *
     * The scheduled sender's route above, shape for shape and each borrowed property
     * load-bearing for the reasons stated there: GET, either shared secret in constant time, 404
     * on a deployment that armed no internal surface — which does mean stranded reservations are
     * NOT reconciled there, and that is the honest state of a host nobody armed a clock on.
     * It runs on `deps.db`, the runtime connection, for the same reason: it reads and writes
     * `drafts`/`outbound_sends` and dials the user's own mail servers through their decrypted
     * credentials.
     *
     * Overlapping pokes are safe for a reason ONE STEP STRONGER than the sender's, and worth
     * stating because the sender's reason does not apply here. That claim flips a status and so
     * genuinely splits the due set; this one writes nothing, so two pokes CAN select the same
     * row. What they cannot do is both write it: every finalizer is compare-and-swap on
     * `status='pending'`, and the loser reads back and reports the winner's state. The cost of an
     * overlap is a duplicate probe, never a wrong outcome and never a second envelope.
     *
     * ── THE DIAL GOES THROUGH ADMISSION, LIKE EVERY OTHER DIAL ON THIS HOST ─────────────────
     *
     * The pass opens at most one connection per distinct mailbox in a batch of three, but "at
     * most three" is a statement about ONE invocation and this host runs many. The per-mailbox
     * admission counter is what makes it a statement about the deployment, and it is the same
     * counter the attachment and probe paths hold — so a mailbox already at its ceiling refuses
     * this pass rather than becoming the connection that trips the provider's own limit. A
     * refusal is a DEFER: the pass counts it and the row is examined again next minute.
     */
    method: "GET",
    pattern: SEND_RECONCILE_CRON_PATH,
    cost: "unauthenticated",
    options: { public: true, anonymous: true, raw: true },
    handler: async (req, deps) => {
      const log = (deps.logger ?? silentLogger).child({ route: SEND_RECONCILE_CRON_PATH });
      const cfg = deps.alerts;
      if (!cfg || cfg.secret.trim().length === 0) {
        return json(404, { error: { code: "not_found" } });
      }
      const cron = cfg.cronSecret?.trim();
      const authorized = presentsSecret(req, cfg.secret)
        || (cron !== undefined && cron.length > 0 && presentsSecret(req, cron));
      if (!authorized) {
        log.warn("send_reconcile_unauthorized", {});
        return json(401, { error: { code: "unauthorized" } });
      }
      try {
        const result = await runSendReconcilePass(deps.db, {
          openSendAdapter: deps.services?.sendAdapter
            ?? ((mailboxId: string) => admittedSendAdapter(deps, mailboxId)),
          // THE SUSPENSION GATE, injected here for `runScheduledSendPass`'s reason (the fact is
          // the cloud half's and the pass ships in the desktop engine bundle) and read on the
          // HANDED handle for its deadlock reason. It gates the DIAL rather than the claim here
          // — see `SendReconcilePassDeps.accountEligible` for why excluding the rows would
          // starve every account behind a parked one.
          accountEligible: async (accountId, handle) =>
            !(await isSuspended(handle as unknown as Tx, accountId)),
          log,
          now: deps.now,
        });
        if (result.claimed > 0) log.info("send_reconcile_pass", { ...result });
        return json(200, { now: deps.now().toISOString(), ...result });
      } catch (err) {
        // `raw` means no error envelope above this handler; it must never throw. Per-row faults
        // are already absorbed inside the pass — this catches only the claim itself.
        log.error("send_reconcile_pass_failed", { err });
        return json(503, { error: { code: "send_reconcile_pass_failed" } });
      }
    },
  },
  {
    method: "GET",
    pattern: "/internal/billing/reconcile",
    cost: "unauthenticated",
    options: { public: true, anonymous: true, raw: true },
    handler: async (req, deps) => reconcilePass(req, deps, "dry-run", "/internal/billing/reconcile"),
  },
  {
    method: "GET",
    pattern: BILLING_RECONCILE_CRON_PATH,
    cost: "unauthenticated",
    options: { public: true, anonymous: true, raw: true },
    handler: async (req, deps) => reconcilePass(req, deps, "apply", BILLING_RECONCILE_CRON_PATH),
  },
];
