import { runAlertPass, listOpenAlerts, newDeliveryStreak } from "@trafficflow/db/cloud";
import { silentLogger, type Logger } from "@trafficflow/core";
import type { Tx } from "@trafficflow/db";
import { reapStaleWebSessions, type AdminDb } from "@trafficflow/services";
import { presentsSecret, secretRouteJson as json } from "../secret-auth.js";
import type { AlertsConfig } from "../deps-cloud.js";
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
 * The PATH Vercel Cron fires the session reaper at — exported for the same reason
 * {@link ALERT_CRON_PATH} is: the host deployment's cron config names it as a literal string
 * and a test asserts the two agree, because a cron whose path this router does not serve is
 * hygiene that "shipped" and silently never runs.
 */
export const SESSIONS_REAP_CRON_PATH = "/internal/sessions/reap";

/**
 * The PATH Vercel Cron fires the `SIZE` back-fill at — exported for the reason the two above it
 * are: the host deployment's cron config names it as a literal string and a test asserts the two
 * agree, because a cron whose path this router does not serve is hygiene that "shipped" and
 * silently never runs.
 */
export const SMTP_SIZE_CRON_PATH = "/internal/mailboxes/smtp-size";

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

async function alertPass(
  cfg: AlertsConfig, log: Logger, now: () => Date, staffDb: () => Promise<AdminDb>,
): Promise<Response> {
  try {
    const result = await runAlertPass(await staffDb(), {
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
    });
  } catch (err) {
    // `raw` means there is no error envelope above this handler, so it must never throw.
    log.error("alert_pass_failed", { err });
    return json(503, { error: { code: "alert_pass_failed" } });
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
];
