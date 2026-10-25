/**
 * The alert vocabulary, apart from the evaluator: what an alert IS, which kinds exist, and how severe and
 * which class each is. alerts.ts re-exports all four, so its importers are unchanged; the mail policy
 * reads them here, which keeps alert-mail-policy.ts and alerts.ts out of an import cycle.
 */

/** The conditions, twenty-five of them. Stable strings — they are the alert identity in `alert_state`. */
export type AlertKind =
  /** No leader heartbeat for a shard within the threshold: nothing is syncing. */
  | "worker_down"
  /** `outbound_sends` still `pending` past the threshold: a send died mid-flight. */
  | "sends_stuck"
  /**
   * A mailbox THE ROSTER IS ON DUTY FOR whose newest sync is older than the threshold.
   * "On duty" is `status <> 'disabled'` AND not PARKED by the host's own reader — the worker's
   * definition, not a second one; see rule 4 for what calling it "enabled" used to cost.
   */
  | "sync_lag"
  /**
   * An on-duty account whose counted stored-body bytes have reached its cap: its mail keeps
   * organizing on IMAP and NEW bodies are being withheld from the hosted store. A scan rule and
   * not an ingest-transition emission, deliberately — at-cap is also ENTERED with no ingest
   * event at all (a shrinking limit reaches it; the 0062 backfill mints day-one at-cap
   * accounts), and the two-driver design already survives the worker being down.
   */
  | "storage_at_cap"
  /**
   * A paired native device (kind ≠ 'web') that used to reach the sync horizon has gone quiet past
   * the threshold while its account kept changing. Read from `devices.last_synced_at` (mail 0064)
   * — stamped only by a `GET /sync` answer with `hasMore: false`, so a mirror stuck re-paging a
   * backlog counts as quiet, exactly like one whose session died. Two arms share this kind and
   * its per-device key: a device that stamped once and went quiet, and one that never stamped
   * (`IS NULL`) older than the threshold, with a live session and an account that moved on —
   * added after the first real incident showed the NULL exclusion was the exact blind spot: every
   * wedged mirror is NULL until it first converges.
   */
  | "device_sync_stale"
  /**
   * A session that used to reach the sync horizon is still making requests but has not converged
   * past the threshold while its account kept changing. Read from `sessions.last_synced_at` (mail
   * 0070) beside `sessions.last_seen_at`. The arm that covers deviceless installs — the
   * browser-door desktop, a long-lived web tab (`device_id IS NULL`, mail 0061) — invisible to
   * `device_sync_stale` by construction. "Still making requests" is the discriminator that keeps
   * a closed tab silent: a wedged install rotates its refresh family and polls on its own
   * backoff, while a closed tab stops presenting anything and ages out.
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
   * ONE ROUTE is answering 5xx above the threshold, read from `api_faults` (cloud 0033).
   *
   * `api_5xx_rate` beside it counts what the PLATFORM served and names no route — it is the only
   * surface that sees a killed invocation, and it depends on a vendor token a deployment may not
   * have. This one is first-party: the API's own error envelope writes the row, so it names the
   * route and the error class and it works with no vendor at all. Neither subsumes the other.
   */
  | "api_fault_rate"
  /**
   * The pooled-acquire ceiling has REFUSED more than the threshold inside the window: the
   * database connection is saturated and requests are being declined rather than served.
   *
   * Deployment-wide and not per route — a saturated pooler refuses whoever asked next. It is a
   * COUNT of refusals and deliberately not a wait p95: nothing records how long an acquire
   * waited, so a percentile here would be invented.
   */
  | "pooler_refusals"
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
   * One account's clients answered off already-consumed refresh tokens repeatedly inside the
   * window — `auth_events` (`event = 'refresh_replayed'`, written by the rotation's retry and
   * convergence arms). One or two is a dropped answer; a burst is a client that cannot ADOPT what
   * it is given, spending rotations it never keeps, and nothing else in this file can see it.
   */
  | "session_refresh_replayed"
  /**
   * THE OTHER ALERT DRIVER RUNS AND CAN PAGE NOBODY, reported by this one: its last pass counted no
   * usable sink, or its last passes asked every arm it has and each one refused. The driver's own
   * `alerts_undeliverable` line is a log line on a host nobody is watching; this is the same fact
   * delivered through the sinks of the driver that can still page.
   */
  | "alert_driver_undeliverable"
  /**
   * One arm of THIS driver's pager has refused a full streak while another arm delivered: the pages
   * still land and the deployment is back to a single vendor. Self-reported, because the driver is
   * alive and its surviving arm is the witness.
   */
  | "alert_sink_degraded"
  /**
   * One of the API routes the worker drives on a clock (`api-cron.ts`), or the 5xx poll it runs
   * itself (`platform_signals`), has not succeeded within twice its cadence with its retry failed
   * too, or within three cadences (floor fifteen minutes): the schedule stopped, the poke is
   * refused, or the pass keeps failing. Evaluated by the worker driver, which holds the schedule's
   * memory; only a success clears it.
   */
  | "api_cron_stale"
  /**
   * The platform-signals poller stopped writing: the newest `platform_signals.fetched_at` of a
   * project is older than the threshold. `api_5xx_rate` reads that table and says "not measured"
   * when it is empty; this says that the measuring stopped.
   */
  | "signal_source_dark"
  /**
   * One of the billing plane's cron passes has not completed within its bound, as the plane states
   * it on `POST /v1/ops` (`stale`, trusted as sent). Keyed by the pass's name. The plane has no
   * pager of its own; it states facts and the alert pass decides what pages.
   */
  | "plane_pass_stale"
  /**
   * A billing alert the plane holds active on `POST /v1/ops`: `events_failed`, `unrecorded`, or a
   * `<stage>:<code>` raised in the last day, keyed by that key. Closed strings only: the reader
   * refuses an answer that could carry an account or event id, so none reaches a row or a sink.
   */
  | "billing_alert"
  /**
   * THIS DRIVER could not read the plane's `POST /v1/ops`: refused, unreachable, or an answer the
   * reader refused whole. Keyed by the driver, like `schema_behind`: one host failing to reach the
   * plane is not the other's to clear. A signal until several reads in a row have failed.
   */
  | "plane_ops_unreadable"
  /**
   * THIS DRIVER'S ALERT PASS COULD NOT USE THE DATABASE (gone, read-only, out of resources, too
   * slow), sent from the pass's failure path out of process memory (`alert-last-resort.ts`): no row
   * is ever written, so nothing reads or resolves it. Keyed by the driver. Emitted by
   * `dbUnreadableAlert` in `alerts.ts`.
   */
  | "alert_db_unreadable";

export type AlertSeverity = "critical" | "warning";

/**
 * Incident or signal — the class that decides delivery, not merely presentation. Severity could
 * not express it: `storage_at_cap` and `sync_lag` are both warnings and only one is a customer
 * being wronged; read off severity alone, an operator woken at 3am cannot tell which needs them
 * now. An incident goes to the sinks and wakes somebody; a signal is recorded and rendered and
 * never reaches a sink. {@link Alert.cls} is optional and absent means incident (see {@link
 * alertClass}): a rule whose author forgot the field pages — the other default silently converts
 * a new incident into a row that reaches no human, the exact silence this file refuses; the cost
 * of the safe direction is a noisy page, which is loud and gets fixed.
 */
export type AlertClass = "incident" | "signal";

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
   * The CONDITION SIGNATURE — the state an `alert_firing` log line keys on. Optional; absent,
   * `"<severity>|<count>"`. Ages grow on every evaluation and never belong in it. Paging reads
   * {@link levels}, not this.
   */
  signature?: string;
  /**
   * HOW BAD the condition is, as numbers where higher is worse — what the pass pages on besides
   * a start and the reminder clock. A page goes out when the severity or any level passes the
   * highest this firing has already paged ({@link escalates}); a fall never pages. Absent:
   * `[pow2Floor(count)]`, one step per doubling. A rule whose badness has another dimension (an
   * age, a second population) names every dimension here.
   */
  levels?: readonly number[];
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
   * The INTERNAL CONSOLE PATH an operator should open to act on this — `/worker`,
   * `/accounts/<uuid>`. Rendered as a link; never fetched server-side. A literal with, at most,
   * an id interpolated into it: nothing here is derived from what any message says.
   */
  fixHref?: string | null;
}
