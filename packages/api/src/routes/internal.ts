import {
  runAlertPass, listOpenAlerts, newDeliveryStreak,
  sinkHealthOf,
  type AlertSink,
} from "@trafficflow/db/cloud";
import { sql } from "drizzle-orm";
import { silentLogger, type Logger } from "@trafficflow/core";
import type { Tx } from "@trafficflow/db";
import {
  runAwayResponderPass,
  reapStaleWebSessions, runPlatformSignalPass,
  runScheduledSendPass, runSendReconcilePass, SEND_RECONCILE_NET_TIMEOUTS,
  TransientDialRefusal, type AdminDb,
} from "@trafficflow/services";
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
 * `POST /internal/alerts` — the outside-the-worker alert driver. A few rules are statements about
 * an arm, and a dead process reports nothing, so those need an observer on another platform
 * reading the same Postgres: `worker_down`, `worker_degraded`, `alert_driver_dark`,
 * `schema_behind` (the count lives in `AlertKind`). Two clocks — Vercel Cron (primary) and the
 * scheduled CI workflow (a failed run mails the operator). A shared secret in constant time; no
 * `deps.alerts` ⇒ 404. POST: it writes and can send mail. The pass runs on the blind handle,
 * writing `alert_state` and `alert_pass_runs`; the mail sink's limiter is the one non-blind
 * piece. Dark pager 503; absent 404.
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
 * The path the platform-signal poll is scheduled at — what the hosting platform actually served,
 * asked every five minutes. A route on this host, not a worker pass: the subject is this host's
 * error rate, and the token that can read it is an env var on this deployment — polling from the
 * worker would provision the platform credential onto a second host to measure the first. Five
 * minutes because the rule reads a fifteen-minute window and needs independent samples: three
 * five-minute rows leave two windows of evidence after a missed poll. A deployment with no
 * platform token writes no row, deliberately — the board renders "5xx: not measured", a different
 * state from zero. Driven by the worker's `api-cron.ts`; a census text-matches this literal.
 */
export const PLATFORM_SIGNALS_CRON_PATH = "/internal/platform-signals/run";

/**
 * The path the scheduled-send pass is scheduled at (Send later, mail 0077) — exported because the
 * worker's `api-cron.ts` names it as a literal and a census asserts the two agree: a schedule
 * whose path this router does not serve is a feature whose promise silently never runs. Poked
 * every minute — the appointment's stated precision is about a minute. The pass runs here, on the
 * API host, measured twice over: the sync host's platform blocks outbound SMTP at the port level
 * (`apps/worker/src/smtp-size.ts`), and the worker's runtime dependency set may not include
 * `@trafficflow/services` — while this host runs `SendService` on every manual send already.
 */
export const SCHEDULED_SEND_CRON_PATH = "/internal/sends/scheduled/run";

/**
 * `GET /internal/sends/reconcile/run` — the reconciling pass for stranded send reservations. A
 * separate route from the sender's clock one line up, and the separation is a budget: that
 * invocation already plans three sends of up to twenty seconds each against this platform's
 * sixty-second kill, so hanging a second batch off it would spend the sender's remaining time on
 * the reconciler's. Both are poked every minute by the same worker clock, on their own staggers.
 * `runSendReconcilePass` holds the whole policy — what "stranded" means, which mailboxes may be
 * dialled, and why nothing on this path can submit.
 */
export const SEND_RECONCILE_CRON_PATH = "/internal/sends/reconcile/run";

/**
 * The away responder's clock. A SEPARATE route from the scheduled sender's, not a second pass
 * folded into it: that invocation already budgets its own sends against this platform's 60-second
 * ceiling, and a slow away run sharing it would eat the appointment clock's margin. Two routes,
 * two cron entries, two independent deadlines.
 */
export const AWAY_RESPONDER_CRON_PATH = "/internal/away/run";

/**
 * `makeSendAdapter` under the per-mailbox admission counter — the reconciling pass's dial:
 * acquire before the credential is decrypted, release exactly once at close; no in-process slot
 * because a refusal is a defer, re-examined a minute later. A refusal is a
 * `TransientDialRefusal`, never a `ServiceError`: `resolveStale` reads a factory `ServiceError`
 * as "never dialable again" and writes a terminal `unverified` — correct for gone credentials,
 * catastrophic for a busy mailbox. Both the refusal and any counter throw are re-raised
 * transient. Nothing fails open. The release is best-effort: losing it costs one slot until the
 * stale-window reclaim.
 */
async function admittedSendAdapter(deps: ApiDeps, mailboxId: string): Promise<SendAdapter> {
  const now = (): Date => deps.now?.() ?? new Date();
  /**
   * The counter itself failing is not evidence about the message either: `imapAdmission()` throws
   * a 500 `ServiceError` when the host supplies no port, the acquire can throw on a database
   * fault, and `resolveStale` reads any factory `ServiceError` as terminal — a deployment with
   * the alert secret armed and no admission port would have closed every stranded reservation as
   * unconfirmed, three a minute, without one Sent-folder search. Re-raised as a transient
   * refusal: the pass defers, the row is untouched, the 24-hour give-up is the bound. Nothing
   * fails open.
   */
  let admitted: boolean;
  try {
    admitted = await imapAdmission(deps).acquire(
      deps.db, { mailboxId, max: MAX_IMAP_PER_MAILBOX, now: now() },
    );
  } catch (err) {
    // `err` itself, not `String(err)`: the logger reduces a thrown value to its class and code,
    // and stringifying first makes every line read `errorClass: "String"` — the missing-port
    // refusal, a pool timeout and a programming error all identical, which is the one thing an
    // error-level line exists to tell apart.
    deps.logger?.error?.("send_reconcile_admission_failed", { mailboxId, err });
    throw new TransientDialRefusal(mailboxId, "the IMAP admission counter could not be consulted");
  }
  if (!admitted) {
    // A `TransientDialRefusal` AND EMPHATICALLY NOT A `ServiceError`. The resolver reads a
    // `ServiceError` from a factory as "this mailbox can never be dialled again" and writes a
    // TERMINAL `unverified` on the spot — correct for a mailbox whose credentials are gone, and
    // exactly wrong here, where the only fact is that two other requests hold the slots right
    // now (the cap is two, and the attachment path holds the same ones). Writing `unverified`
    // for that would tell somebody their send could not be confirmed without the Sent folder
    // ever having been looked at, and terminal means no later cycle would ever look.
    throw new TransientDialRefusal(
      mailboxId,
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
      deps.logger?.warn?.("imap_slot_release_failed", { mailboxId, err });
    }
  };

  let adapter: SendAdapter;
  try {
    adapter = await makeSendAdapter(deps, mailboxId, {
      // THE RECONCILER'S OWN DEADLINES, not the send path's. Three dials share one 60-second
      // invocation here, where the defaults were chosen for a single send to fit in — and a
      // breach of these is the ADAPTER's honest answer rather than a caller giving up on a
      // command that then keeps running, which is why they are threaded and not raced.
      timeouts: SEND_RECONCILE_NET_TIMEOUTS,
    });
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
    // FORWARDED, and the slot still comes back. A caller reaches for this because it abandoned a
    // timed-out operation, so it must not be made to wait — the release is fired and not awaited,
    // and its own failure path already logs. Losing it leaves the mailbox one unit short until the
    // stale-window reclaim, which is the bounded direction; blocking here would reintroduce the
    // hang this method exists to escape.
    ...(adapter.forceClose ? {
      forceClose: (): void => {
        adapter.forceClose!();
        void release();
      },
    } : {}),
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
 * Run one pass and answer it, shared by all three drivers (the CI POST, the platform cron GET, an
 * operator with curl): two copies of the logging block is where the surfaces drift and an
 * incident gets logged differently depending on which clock observed it. It takes four narrow
 * values and not `ApiDeps`: this runs behind a staff credential with cross-account reach and
 * needed exactly `deps.logger` and `deps.now` — handing it the whole bag would hand it `deps.db`,
 * the user-serving runtime connection, the capability `/admin/*` just finished removing from its
 * own callbacks.
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
 * How many passes this instance has completed, and the only reason it is counted:
 * `apiDeliveryStreak` accumulates only while an instance stays warm, so a cold instance answers
 * `attempts: 0` for arms that have delivered for months — published bare, those zeros read as
 * "the pager has never worked", a lie in the direction `/health` may never lie in. This number is
 * the qualifier: `passes: 0` says the counters are cold; `passes: 40` with `attempts: 0` says
 * forty quiet passes. Incremented the moment a pass can mutate the streak — see the comment at
 * the increment.
 */
let apiAlertPasses = 0;

/**
 * The pager's standing health as `GET /health` publishes it — the one reader of the streak that
 * is not the pass itself. The worker names its arms in a startup line; a serverless host has
 * none, and it is the only observer of a dead worker. Derived, never stored (a cached copy would
 * drift from the streak the pass mutates); memory only, readable exactly when the database cannot
 * be. The mail-half `AlertSinkSummary`, projected field by field: structural assignability
 * accepts a wider object and `JSON.stringify` publishes what an object holds — naming every field
 * makes a later `AlertSinkHealth` addition a compile error, not new text on a public endpoint.
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
    // Counted the instant the pass can touch the streak; the placement is the field's
    // correctness. Counting after `runAlertPass` returned was false in a supported state: the
    // streak is mutated by `deliver()` and only then are the claims settled, so a settle UPDATE
    // that fails throws after the per-arm counters advanced — fresh attempts beside `passes: 0`,
    // the qualifier calling its own neighbours cold. Counting on entry makes the two inseparable;
    // an invocation that cannot mutate the streak (no staff handle — the await above rejects
    // first) is not counted. The number means "passes RUN", not "completed": a failing pass
    // answers 503 and logs `alert_pass_failed`, which is where it is diagnosed. The one thing
    // this field must never do is call warm counters cold.
    apiAlertPasses++;
    const result = await runAlertPass(staff, {
      now: now(),
      sinks: cfg.sinks ?? [],
      shards: cfg.shards,
      thresholds: cfg.thresholds,
      ...(cfg.parkedAccounts ? { parkedAccounts: cfg.parkedAccounts } : {}),
      ...(cfg.accountsAtCap ? { accountsAtCap: cfg.accountsAtCap } : {}),
      repeatMs: cfg.repeatMs,
      source: "api",
      environment: cfg.environment ?? "production",
      deliveryStreak: apiDeliveryStreak,
      // THE DRIVER'S OWN NAME — see the worker's call site for the argument. This arm is the
      // only observer of `worker_down`, and it is now also the only observer of the worker
      // driver's own silence; the worker's pass watches this one in return.
      driver: "api",
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
 * One platform-signal poll, `platformCostPass`'s shape — 404 unarmed, either secret in constant
 * time, no "unconfigured" skip. The part worth reading twice: an unconfigured deployment is
 * settled by an absence — the port answers `unconfigured`, the pass writes no row, the rule
 * cannot fire, the board says "not measured". At no point does a `0` exist to render: a pass
 * writing zeros would satisfy every test and put a measured-looking zero on screen for a figure
 * nobody asked the platform for. Runs on `deps.db`: it writes `platform_signals`, and the blind
 * handle holds SELECT and must not gain more.
 */
async function platformSignalPass(req: Request, deps: ApiDeps): Promise<Response> {
  const log = (deps.logger ?? silentLogger).child({ route: PLATFORM_SIGNALS_CRON_PATH });
  const cfg = deps.alerts;
  if (!cfg || cfg.secret.trim().length === 0) {
    return json(404, { error: { code: "not_found" } });
  }
  const cron = cfg.cronSecret?.trim();
  const authorized = presentsSecret(req, cfg.secret)
    || (cron !== undefined && cron.length > 0 && presentsSecret(req, cron));
  if (!authorized) {
    log.warn("platform_signals_unauthorized", {});
    return json(401, { error: { code: "unauthorized" } });
  }
  const port = deps.services?.platformSignals;
  if (!port) {
    // A host that composed no port at all — the desktop engine's shape. DISTINCT from a port that
    // answers `unconfigured`: that one asked and found no token. Both write nothing; only this
    // one means nobody wired the question.
    return json(200, { skipped: "signal_port_unconfigured" });
  }
  try {
    const report = await runPlatformSignalPass(deps.db, { port, now: deps.now });
    // INFO on every pass rather than only on a change, `platformCostPass`'s reason verbatim: this
    // is a surface where "nothing was written" is the expected answer for as long as no token
    // exists, and a log line that appeared only on success would make the healthy unconfigured
    // state look exactly like a dead clock.
    log.info("platform_signal_pass", {
      outcome: report.outcome, rows: report.rows, pruned: report.pruned,
      ...(report.code ? { code: report.code } : {}),
    });
    // A semantic failure must not be a 200, because the caller reads only the status: the
    // worker's cron driver discards the body and looks at `res.ok`. A poll that could not
    // authenticate or resolve its project returns `outcome: "failed"` and wrote nothing —
    // answering 200 for that made the worker record the target healthy and reset its failure
    // streak, a perfectly running schedule over no signal data: the broken state rendering as the
    // healthy one. `unconfigured` stays 200 and must — a deployment with no token has nothing to
    // report and is not failing; that distinction is why this branches on `outcome`, not on
    // whether a row was written.
    if (report.outcome === "failed") {
      return json(502, { now: deps.now().toISOString(), ...report });
    }
    return json(200, { now: deps.now().toISOString(), ...report });
  } catch (err) {
    // `raw` means no error envelope above this handler; it must never throw. The pass absorbs
    // fetch faults itself, so this catches only a database refusal.
    log.error("platform_signal_pass_failed", { err });
    return json(503, { error: { code: "platform_signal_pass_failed" } });
  }
}

/**
 * `POST /internal/fault` — make this deployment answer one 5xx, on purpose.
 *
 * Only a real request proves the WIRING of cloud 0033: the port reached the composition root,
 * the row reached the table, the grant let the reader see it. Every way that fails renders as
 * an empty table, which is also what a healthy deployment looks like.
 *
 * TWO independent arming conditions, neither a new flag: the internal secret, AND a fault log
 * on this host. The second keeps the route reachable only where the mechanism it tests exists.
 */
const faultProbeRoute: Route = {
  method: "POST",
  pattern: "/internal/fault",
  cost: "unauthenticated",
  relay: false,  /* the hosted service's shared-secret intake */
  /**
   * `public`, and NEITHER `raw` NOR `anonymous` — the one line to get right. `withErrorEnvelope`
   * is in FULL_PIPELINE only, so either flag would throw past the middleware under test and the
   * suite would pass against a 500 the host invented.
   */
  options: { public: true },
  handler: async (req, deps) => {
    if (!deps.faultLog) return json(404, { error: { code: "not_found" } });
    const secret = deps.alerts?.secret ?? "";
    if (secret.trim().length === 0) return json(404, { error: { code: "not_found" } });
    if (!presentsSecret(req, secret)) {
      (deps.logger ?? silentLogger).warn("fault_probe_unauthorized", {});
      return json(401, { error: { code: "unauthorized" } });
    }
    // An UNMODELLED throw, which is the branch that matters: a `ServiceError` is a fault the code
    // already has a name for, and this one lands in the envelope's `request_unhandled` arm — the
    // population `api_fault_rate` exists to notice. The class name is what reaches the row, so it
    // says what it is; the message never leaves this process.
    throw new FaultProbeError();
  },
};

/** The class name cloud 0033's `error_class` records for a probe. Never a real fault's name. */
class FaultProbeError extends Error {
  constructor() {
    super("deliberate fault from POST /internal/fault");
    this.name = "FaultProbeError";
  }
}

export const internalRoutes: Route[] = [
  faultProbeRoute,
  {
    method: "POST",
    pattern: "/internal/alerts",
    relay: false,  /* the hosted service's shared-secret intake */
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
     * `GET /internal/alerts/run` — the platform cron's entry point. Vercel Cron issues GET and
     * only GET, and "no platform cron" leaves the only external clock on a best-effort schedule
     * disabled after 60 days of repository inactivity — a dead-man's switch with an expiry date.
     * The POST's objection was never about the verb: a link preview cannot present a bearer
     * token, so an unauthenticated GET is a 401 and nothing runs. A separate path from `GET
     * /internal/alerts` because that is the runbook's safe read; overloading it would make the
     * documented diagnostic command page people. Two accepted secrets, both constant-time; see
     * {@link AlertsConfig.cronSecret}.
     */
    method: "GET",
    pattern: ALERT_CRON_PATH,
    relay: false,  /* the hosted service's shared-secret intake */
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
    relay: false,  /* the hosted service's shared-secret intake */
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
     * `GET /internal/sessions/reap` — the web-session reaper's clock: revokes plain browser
     * sessions (`device_id IS NULL`, scope `full`) unseen for over sixty days, families included;
     * paired devices are structurally out of reach (`reapStaleWebSessions`). The alert cron's
     * shape verbatim: GET (a crawler cannot present a bearer token), either secret, 404 unarmed —
     * where the hygiene then does not run; the live acceptance curls the armed route. On
     * `deps.db`, not the blind handle — argued, not inherited: revoking sessions is session
     * machinery on user tables, a write grant `ohmail_admin` must not gain.
     */
    method: "GET",
    pattern: SESSIONS_REAP_CRON_PATH,
    relay: false,  /* the hosted service's shared-secret intake */
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
     * `GET /internal/mailboxes/smtp-size` — learn what existing mailboxes' servers accept.
     * `smtp_max_size_bytes` is the only ceiling left once bytes stop riding the send request, and
     * nothing ever learned it for an already-connected mailbox. This pass closes that, a bounded
     * batch at a time — `learnMissingSmtpSizes` holds the policy, including why it runs here and
     * not on the sync worker (that platform blocks outbound submission ports; measured). The
     * reaper's shape: GET, either secret, 404 unarmed — where the back-fill then does not run. On
     * `deps.db`. It opens sockets to third parties, which is why the batch and deadline are
     * constants.
     */
    method: "GET",
    pattern: SMTP_SIZE_CRON_PATH,
    relay: false,  /* the hosted service's shared-secret intake */
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
  /**
   * The billing reconciliation — a safe read and an armed clock, because the thing guarded is
   * money state. The dry run compares the plane's subscription list against the
   * `billing_subscriptions` mirror and reports what an armed pass would re-emit — codes and ids
   * only. The hourly pass re-emits each divergence through `EntitlementsService.applyEvent` — the
   * same claim+apply transaction the webhook calls: no second write path into the mirror. Both
   * record their run in `billing_reconciliation_runs`. Two departures: billing unconfigured
   * answers 200 `{skipped}`, not 5xx (the tripwire is the stale-run alert — skipped passes insert
   * no row); and it runs on `deps.db`, grants the blind role must not gain.
   */
  {
    /**
     * `GET /internal/sends/scheduled/run` — Send later's sender pass (mail 0077): claims due
     * `drafts.send_at` appointments and runs the ordinary gated send with the row's own stored
     * Idempotency-Key (`runScheduledSendPass` holds the policy). The reaper's shape: GET, either
     * secret, 404 unarmed — where scheduled sends then do not fire, the honest state of an
     * unarmed host. On `deps.db`: it reads and writes `drafts`/`outbound_sends` and dials the
     * user's own servers. Overlapping pokes are safe: the claim is `FOR UPDATE SKIP LOCKED` and
     * every send is keyed, so two invocations split the due set.
     */
    method: "GET",
    pattern: SCHEDULED_SEND_CRON_PATH,
    relay: false,  /* the hosted service's shared-secret intake */
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
          /* NO ELIGIBILITY GATE HERE, and the absence is a known window rather than a decision.
           * The fact this read (`account_suspensions`) no longer lives in this database, and the
           * entitlements port may not be dialled inside a claim transaction — a network hop there
           * queues behind the transaction holding the connection and every poke times out. The
           * pass defaults to ELIGIBLE, so a parked account's automation keeps firing until the
           * port read is composed ABOVE the claim. */
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
     * `GET /internal/sends/reconcile/run` — the reconciler for stranded reservations; the
     * scheduled sender's route shape for shape. Overlapping pokes are safe one step more
     * strongly: this pass writes nothing at claim time, so two pokes can select the same row —
     * what they cannot do is both write it: every finalizer is compare-and-swap on
     * `status='pending'`, and the loser reads back the winner's state. The cost of an overlap is
     * a duplicate probe, never a second envelope. The dial goes through admission like every dial
     * on this host — the per-mailbox counter turns "at most three per invocation" into a
     * statement about the deployment; a refusal is a defer.
     */
    method: "GET",
    pattern: SEND_RECONCILE_CRON_PATH,
    relay: false,  /* the hosted service's shared-secret intake */
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
          /* NO ELIGIBILITY GATE HERE, and the absence is a known window rather than a decision.
           * The fact this read (`account_suspensions`) no longer lives in this database, and the
           * entitlements port may not be dialled inside a claim transaction — a network hop there
           * queues behind the transaction holding the connection and every poke times out. The
           * pass defaults to ELIGIBLE, so a parked account's automation keeps firing until the
           * port read is composed ABOVE the claim. */
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
    /**
     * `GET /internal/away/run` — the away responder's sender (mail 0087), on this host for a
     * measured reason: the sync worker's platform blocks outbound SMTP at the port level, and the
     * responder used to run there — almost certainly never delivering a reply, each failed dial
     * keeping its at-most-once claim and silencing that correspondent for the episode. On
     * `deps.db`: it reads and writes `away_replies`/`away_sender_state` and dials the user's own
     * servers. Overlapping pokes are safe: the reservation is `INSERT … ON CONFLICT DO NOTHING
     * RETURNING`, and the per-sender throttle is an upsert whose `WHERE` decides.
     */
    method: "GET",
    pattern: AWAY_RESPONDER_CRON_PATH,
    relay: false,  /* the hosted service's shared-secret intake */
    cost: "unauthenticated",
    options: { public: true, anonymous: true, raw: true },
    handler: async (req, deps) => {
      const log = (deps.logger ?? silentLogger).child({ route: AWAY_RESPONDER_CRON_PATH });
      const cfg = deps.alerts;
      if (!cfg || cfg.secret.trim().length === 0) {
        return json(404, { error: { code: "not_found" } });
      }
      const cron = cfg.cronSecret?.trim();
      const authorized = presentsSecret(req, cfg.secret)
        || (cron !== undefined && cron.length > 0 && presentsSecret(req, cron));
      if (!authorized) {
        log.warn("away_responder_unauthorized", {});
        return json(401, { error: { code: "unauthorized" } });
      }
      try {
        const result = await runAwayResponderPass(deps.db, {
          openSendAdapter: deps.services?.sendAdapter
            ?? ((mailboxId: string) => makeSendAdapter(deps, mailboxId)),
          // THE SUSPENSION GATE, injected here because the fact is the cloud half's
          // (`account_suspensions`) and the pass ships in the desktop engine bundle, which may not
          // name a cloud table. A suspended account's automation must not keep firing — mail
          // leaving somebody's mailbox is exactly such automation — so its candidates are not even
          // examined and nothing is recorded as decided, which is what lets the replies go out
          // promptly once the suspension lifts.
          //
          // NO ELIGIBILITY GATE HERE — see the scheduled sender's note above. The pass defaults
          // to ELIGIBLE, so a parked account's away replies keep going out until the port read
          // is composed for these three passes.
          log,
          now: deps.now,
        });
        if (result.examined > 0 || result.sent > 0) log.info("away_responder_pass", { ...result });
        return json(200, { now: deps.now().toISOString(), ...result });
      } catch (err) {
        // `raw` means no error envelope above this handler; it must never throw. Per-account and
        // per-row faults are absorbed inside the pass — this catches only the live-responder probe.
        log.error("away_responder_pass_failed", { err });
        return json(503, { error: { code: "away_responder_pass_failed" } });
      }
    },
  },
  {
    /**
     * `GET /internal/platform-signals/run` — what the platform SERVED, every five minutes.
     *
     * The cost pass's shape verbatim, each borrowed property load-bearing for the reasons stated
     * there: GET because a cron issues GET and only GET; either shared secret in constant time;
     * 404 on a deployment that armed no internal surface — which does mean the 5xx rate is NOT
     * measured there, and that is the honest state of a host nobody armed a clock on.
     */
    method: "GET",
    pattern: PLATFORM_SIGNALS_CRON_PATH,
    relay: false,  /* the hosted service's shared-secret intake */
    cost: "unauthenticated",
    options: { public: true, anonymous: true, raw: true },
    handler: async (req, deps) => platformSignalPass(req, deps),
  },
];
