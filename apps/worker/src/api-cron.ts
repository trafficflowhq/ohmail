import { silentLogger, type Logger } from "@trafficflow/core";

/**
 * THE SCHEDULE FOR THE API HOST'S INTERNAL PASSES — driven from HERE, the always-on process,
 * because the platform layer that was supposed to drive them measurably does not.
 *
 * ── WHY THE WORKER AND NOT VERCEL CRON, WHICH IS THE OBVIOUS THING ──────────────────────────
 *
 * Three of the API's internal routes exist to be run on a clock: the billing reconciliation
 * (`/internal/billing/reconcile/run`, hourly), the web-session reaper (`/internal/sessions/reap`,
 * daily) and the SMTP `SIZE` back-fill (`/internal/mailboxes/smtp-size`, daily — it MUST run on
 * the API host, whose SMTP egress works; the sync host's is port-blocked, measured in
 * `./smtp-size.ts`). All three were scheduled as Vercel Cron entries in the API deployment's
 * own `vercel.json`, and that layer was DARK: the alerts cron sat in that file from 2026-08-01, dozens of
 * production deploys carried it, and on 2026-08-22 `vercel crons ls` still reported every entry
 * "not deployed" — no build log ever mentioned crons, no run ever fired, and nothing errored.
 * A schedule that fails to register SILENTLY, on a platform whose "Ready" status has already
 * been caught serving a stale build, cannot be the thing correctness leans on.
 *
 * This process is the opposite case on every axis: it is always on, its timers demonstrably
 * fire (the 60 s alert pass), it already holds a leader lock that makes "exactly one of me"
 * structural rather than hoped, and it has a `/health` surface where a schedule that stops is
 * VISIBLE (`apiCron`, below) instead of silently absent. So the worker pokes the API's routes
 * over HTTPS with the same bearer secret the routes already accept, and the platform cron
 * entries for these three routes are gone — one driver per route, so "no route runs twice
 * concurrently" is a property of the shape rather than of luck.
 *
 * `/internal/alerts/run` is deliberately NOT in this table, twice over: this process already
 * runs the alert pass in-process every minute (poking the API's copy would double-page), and
 * the pass's job includes reporting THIS WORKER'S DEATH — a dead worker stops poking, so the
 * one route whose driver must outlive the worker cannot be driven from it. Its off-worker
 * drivers stay what they were: the one surviving platform cron entry (kept, would-be primary)
 * and an external scheduler on a third platform, so no single vendor's outage silences it.
 *
 * ── THE CADENCE RESTARTS WITH LEADERSHIP, AND THAT IS A DECISION, NOT AN ACCIDENT ────────────
 *
 * Every target runs once shortly after this instance becomes leader, then on its interval.
 * The alternative — anchor the dailies to the clock and wait out the full interval — starves
 * them on a fleet that redeploys more than once a day, which this one does: a process that
 * never lives 24 h never fires a boot-anchored daily AT ALL. Running early instead of late is
 * safe because all three passes are idempotent and self-bounding: the reconciler heals toward
 * the same fixed point every run, the reaper deletes only what is already expired, and the
 * SIZE back-fill carries its own per-mailbox probe backoff on the API side. The cost of a
 * deploy-happy day is a few extra bounded passes; the cost of the other choice is a daily
 * that structurally never runs.
 *
 * ── OVERLAP, ALL THREE WAYS IT COULD HAPPEN ─────────────────────────────────────────────────
 *
 *  · same target, same process: the next timer is armed only AFTER the in-flight attempt
 *    settles (a `setTimeout` chain, not `setInterval`), and `runOnce` additionally refuses
 *    re-entry — belt and suspenders, because the chain is one refactor away from an interval.
 *  · two replicas (a rolling deploy): this starts inside `startWorkerWithLock`, so only the
 *    lock holder schedules; the first poke is further delayed past the takeover window so an
 *    outgoing leader's in-flight request has settled long before the incoming one's first.
 *  · two shards: gated to shard 0 at the call site — these passes are deployment-wide, not
 *    per-shard, and N shards poking hourly is N− 1 too many.
 *
 * ── WHAT `/health` SAYS, AND WHY CLOSED CODES ───────────────────────────────────────────────
 *
 * `AlertSinkHealth`'s vocabulary, deliberately: per target, the last closed outcome, attempt
 * and success clocks, and a failure streak. `attempts: 0` with `lastOkAt: null` is "never
 * exercised", which is not the same claim as healthy — absence of evidence, said out loud.
 * Outcomes are a closed set and the response body is never quoted: this endpoint is reachable
 * by anyone, and the API host logs its own passes' particulars.
 */
export interface ApiCronTarget {
  /** Closed name, stable across renames of the path — the key an operator greps for. */
  target: "billing_reconcile" | "sessions_reap" | "smtp_size" | "scheduled_send" | "send_reconcile";
  /** The API route, poked as `GET {baseUrl}{route}` with the bearer secret. */
  route: string;
  /** The cadence. Jitter (up to {@link jitterMs}) is ADDED per wait, never subtracted. */
  everyMs: number;
  /** Delay after leadership before the first poke — staggered so the targets never land together. */
  firstDelayMs: number;
  /** Per-request abort bound. Generous: the route's own platform bound is the real ceiling. */
  timeoutMs: number;
  /**
   * Per-target jitter ceiling; absent ⇒ {@link API_CRON_JITTER_MS}. It exists for the one
   * target whose cadence is FINER than the default jitter: a minute clock wearing five minutes
   * of jitter is a schedule made mostly of jitter, and the scheduled-send pass's stated
   * precision ("±about a minute") would be a sentence the arithmetic contradicts. Hygiene the
   * default exists for still applies, scaled to the cadence.
   */
  jitterMs?: number;
}

/**
 * The table. Paths are LITERALS on purpose: a census test in the API host's own suite
 * text-matches this file against the route constants in `packages/api/src/routes/internal.ts`,
 * so a route that moves without its schedule (or a schedule pointing at a path the router does
 * not serve — the decorative-pointer failure this repo has already paid for) is a red test,
 * not a discovery. The same test asserts `/internal/alerts/run` does NOT appear here.
 */
export const API_CRON_TARGETS: readonly ApiCronTarget[] = [
  {
    target: "billing_reconcile",
    route: "/internal/billing/reconcile/run",
    everyMs: 60 * 60 * 1000,
    // Past the rolling-deploy takeover window (measured seconds, bounded by lock heartbeats),
    // and FIRST of the three: the staleness alert (`billing_reconciliation_stale`, 6 h) is the
    // net under this schedule, and a fresh leader should put a run on the ledger promptly.
    firstDelayMs: 90 * 1000,
    timeoutMs: 120 * 1000,
  },
  {
    target: "sessions_reap",
    route: "/internal/sessions/reap",
    everyMs: 24 * 60 * 60 * 1000,
    firstDelayMs: 4 * 60 * 1000,
    timeoutMs: 60 * 1000,
  },
  {
    target: "smtp_size",
    route: "/internal/mailboxes/smtp-size",
    everyMs: 24 * 60 * 60 * 1000,
    // Latest: it opens sockets to third-party SMTP servers (bounded batch, API-side deadline)
    // and is the least urgent of the three.
    firstDelayMs: 7 * 60 * 1000,
    timeoutMs: 120 * 1000,
  },
  {
    // SEND LATER's sender clock (mail 0077): claim due `drafts.send_at` appointments, run the
    // ordinary gated send on each. EVERY MINUTE — the appointment's stated precision is
    // "±about a minute", so the clock has to be at least that fine; the route itself bounds
    // the work (a claim of `SCHEDULED_SEND_BATCH`, `FOR UPDATE SKIP LOCKED`), so an idle
    // minute costs one indexed scan of a near-empty partial index. It runs on the API host
    // for the smtp_size target's own measured reason — this platform blocks outbound SMTP
    // submission — plus one of its own: the services package may not enter this app's
    // runtime dependency set (see package.json), and the pass IS the send service.
    target: "scheduled_send",
    route: "/internal/sends/scheduled/run",
    everyMs: 60 * 1000,
    // Early — an appointment due during a deploy should not wait out a long stagger — but
    // still past the takeover window, and overlap with an outgoing leader's in-flight poke is
    // SAFE here anyway: the claim is SKIP LOCKED and every send is idempotency-keyed, so two
    // pokes split the due set rather than double-sending.
    firstDelayMs: 45 * 1000,
    // The route claims only what one serverless invocation can deliver inside its own
    // 60-second ceiling; this bound is the caller's mirror of that ceiling, not a hope.
    timeoutMs: 60 * 1000,
    // A tenth of the cadence — see {@link ApiCronTarget.jitterMs}.
    jitterMs: 6 * 1000,
  },
  {
    // THE RECONCILER for stranded send reservations — a `pending` row whose sender died or was
    // killed by its platform, which no client is coming back to retry. Its own route rather than
    // a second job on the sender's above: that invocation already budgets three sends of up to
    // twenty seconds each against the same sixty-second kill, so sharing it would spend the
    // sender's remaining time on this one's probes.
    //
    // EVERY MINUTE, and the cadence is what the alert threshold is written against: a row becomes
    // eligible ten minutes after it was reserved, and `stuckSendMs` (fifteen minutes) leaves this
    // clock several cycles to drain it before a human is paged. A slower cadence here would make
    // that alarm fire on healthy reconciliation.
    target: "send_reconcile",
    route: "/internal/sends/reconcile/run",
    everyMs: 60 * 1000,
    // Its own stagger, DISTINCT from the sender's 45 s: the two run on the same host and both
    // may dial the same person's mailbox, so landing them together would be two clocks competing
    // for one admission slot every minute, for ever. Late in the cycle rather than early —
    // nothing here is time-critical to the second, and a row that waits one more minute has
    // already waited ten.
    firstDelayMs: 105 * 1000,
    // The pass opens at most `SEND_RECONCILE_BATCH` LOGINS per invocation, which is the cost the
    // 60-second ceiling is actually budgeted against; this bound is the caller's mirror of that
    // ceiling, not a hope. It EXAMINES more rows than that — a mirror hit settles a reservation
    // with one indexed read and no connection — so the row count is not the number to budget
    // from, and this comment says logins for that reason.
    timeoutMs: 60 * 1000,
    // A tenth of the cadence — the sender's reason, one target over.
    jitterMs: 6 * 1000,
  },
];

/** Up to this much is added to every wait, uniformly — thundering-herd hygiene, never drift backwards. */
export const API_CRON_JITTER_MS = 5 * 60 * 1000;

/**
 * The closed outcome set. `http_401` and `http_404` are named apart from `http_error` because
 * each is a specific misconfiguration with a specific fix: 401 is a secret that does not match
 * the API's (`TF_API_CRON_SECRET` vs the API host's `TF_ALERT_SECRET`/`CRON_SECRET`), 404 is an
 * API deployment that armed no internal surface at all (no `TF_ALERT_SECRET` there).
 */
export type ApiCronOutcome =
  | "ok"          // 2xx
  | "http_401"    // secret rejected
  | "http_404"    // no armed internal surface on the API host
  | "http_error"  // any other non-2xx (the route's own 503s land here)
  | "timeout"     // aborted at timeoutMs
  | "unreachable"; // fetch threw before a status existed

/** One target's standing report on `/health` — `AlertSinkHealth`'s shape, for the same reasons. */
export interface ApiCronTargetHealth {
  target: string;
  route: string;
  everySeconds: number;
  /** Most recent closed code, or null — never attempted. */
  outcome: ApiCronOutcome | null;
  consecutiveFailures: number;
  attempts: number;
  lastOkAt: string | null;
  lastAttemptAt: string | null;
}

export interface ApiCronDeps {
  /** e.g. `https://api.ohmail.app` — trailing slashes are stripped once, here. */
  baseUrl: string;
  /** Presented as `Authorization: Bearer …`; must match the API's `TF_ALERT_SECRET` or `CRON_SECRET`. */
  secret: string;
  log?: Logger;
  targets?: readonly ApiCronTarget[];
  /** Seams for tests — the scheduler must be provable without real clocks or sockets. */
  fetchImpl?: typeof fetch;
  now?: () => Date;
  random?: () => number;
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
}

export interface ApiCronHandle {
  /** Memory read — `/health` touches no database, and this keeps that true. */
  health(): ApiCronTargetHealth[];
  /** Idempotent. Clears every armed timer and aborts every in-flight request. */
  stop(): void;
}

interface TargetState {
  outcome: ApiCronOutcome | null;
  consecutiveFailures: number;
  attempts: number;
  lastOkAt: Date | null;
  lastAttemptAt: Date | null;
  inFlight: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  controller: AbortController | null;
}

export function startApiCron(deps: ApiCronDeps): ApiCronHandle {
  const log = deps.log ?? silentLogger;
  const targets = deps.targets ?? API_CRON_TARGETS;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? ((): Date => new Date());
  const random = deps.random ?? Math.random;
  const setTimer = deps.setTimer ?? setTimeout;
  const clearTimer = deps.clearTimer ?? clearTimeout;
  const baseUrl = deps.baseUrl.replace(/\/+$/, "");

  let stopped = false;
  const states = new Map<string, TargetState>();
  for (const t of targets) {
    states.set(t.target, {
      outcome: null, consecutiveFailures: 0, attempts: 0,
      lastOkAt: null, lastAttemptAt: null, inFlight: false, timer: null, controller: null,
    });
  }

  function arm(t: ApiCronTarget, baseDelayMs: number, jitterMs: number): void {
    if (stopped) return;
    const state = states.get(t.target)!;
    state.timer = setTimer(() => { void runOnce(t); }, baseDelayMs + Math.floor(random() * jitterMs));
  }

  /**
   * Never throws — this runs off a timer, and an unhandled rejection here would take down a
   * worker that is syncing mail perfectly well over a scheduling convenience. Every exit arm
   * re-arms the chain (unless stopped), so one bad pass never kills the cadence.
   */
  async function runOnce(t: ApiCronTarget): Promise<void> {
    if (stopped) return;
    const state = states.get(t.target)!;
    // Re-entry guard. The chain alone already prevents this (the next timer is armed in
    // `finally`), but the chain is a property of this function's current shape, and the cost
    // of a second concurrent armed pass — two reconciliations interleaving their applies —
    // is exactly what this module exists to make unrepresentable.
    if (state.inFlight) return;
    state.inFlight = true;
    state.attempts += 1;
    state.lastAttemptAt = now();
    const started = Date.now();
    const controller = new AbortController();
    state.controller = controller;
    const timeout = setTimer(() => { controller.abort(); }, t.timeoutMs);
    let outcome: ApiCronOutcome;
    let status: number | null = null;
    try {
      const res = await fetchImpl(`${baseUrl}${t.route}`, {
        method: "GET",
        headers: { authorization: `Bearer ${deps.secret}` },
        signal: controller.signal,
      });
      status = res.status;
      // The body is DRAINED and dropped: keep-alive hygiene, and nothing from it is logged —
      // the API host logs its own passes, and closed codes are all this side keeps.
      try { await res.arrayBuffer(); } catch { /* the status already answered */ }
      outcome = res.ok ? "ok"
        : res.status === 401 ? "http_401"
        : res.status === 404 ? "http_404"
        : "http_error";
    } catch (err) {
      outcome = controller.signal.aborted ? "timeout" : "unreachable";
      if (outcome === "unreachable") {
        log.warn("api_cron_unreachable", { route: t.route, err });
      }
    } finally {
      clearTimer(timeout);
      state.controller = null;
      state.inFlight = false;
    }
    state.outcome = outcome;
    const latencyMs = Date.now() - started;
    if (outcome === "ok") {
      state.consecutiveFailures = 0;
      state.lastOkAt = now();
      log.info("api_cron_ok", { route: t.route, status: status ?? undefined, latencyMs });
    } else {
      state.consecutiveFailures += 1;
      // WARN on the first refusal, ERROR once it is a streak: one failed poke is a blip the
      // next interval absorbs; three is a schedule that has stopped, which for the reconciler
      // is the exact condition `billing_reconciliation_stale` exists to page on — this line
      // makes the cause readable before the page lands.
      const line = state.consecutiveFailures >= 3 ? log.error.bind(log) : log.warn.bind(log);
      line("api_cron_failed", {
        route: t.route, outcome, status: status ?? undefined, latencyMs,
        consecutiveFailures: state.consecutiveFailures,
      });
    }
    arm(t, t.everyMs, t.jitterMs ?? API_CRON_JITTER_MS);
  }

  for (const t of targets) arm(t, t.firstDelayMs, 30 * 1000);
  log.info("api_cron_started", {
    host: new URL(baseUrl).host,
    count: targets.length,
    sample: targets.map((t) => t.target).join(","),
  });

  return {
    health(): ApiCronTargetHealth[] {
      return targets.map((t) => {
        const s = states.get(t.target)!;
        return {
          target: t.target,
          route: t.route,
          everySeconds: Math.round(t.everyMs / 1000),
          outcome: s.outcome,
          consecutiveFailures: s.consecutiveFailures,
          attempts: s.attempts,
          lastOkAt: s.lastOkAt ? s.lastOkAt.toISOString() : null,
          lastAttemptAt: s.lastAttemptAt ? s.lastAttemptAt.toISOString() : null,
        };
      });
    },
    stop(): void {
      stopped = true;
      for (const s of states.values()) {
        if (s.timer !== null) { clearTimer(s.timer); s.timer = null; }
        // Abort the in-flight request too: a leader told to stop is usually about to lose the
        // lock to a successor whose own first poke must not overlap this one.
        s.controller?.abort();
      }
    },
  };
}
