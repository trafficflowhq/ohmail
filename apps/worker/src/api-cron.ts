import { silentLogger, type Logger } from "@trafficflow/core";
import { UNSUB_DRAIN_CEILING_MS } from "@trafficflow/core/mail";

/**
 * THE SCHEDULE FOR THE API HOST'S INTERNAL PASSES — driven from HERE, the always-on process, because
 * the platform layer that was supposed to drive them measurably does not. Three API routes run on a
 * clock (billing reconciliation hourly, `/internal/sessions/reap` daily, `/internal/mailboxes/smtp-size`
 * daily — it MUST run on the API host, whose SMTP egress works; measured in `./smtp-size.ts`). Scheduled
 * as Vercel Cron in the API's `vercel.json`, that layer was DARK: an entry from 2026-08-01 still read
 * "not deployed" on 2026-08-22 (`vercel crons ls`), no run ever fired, nothing errored. This process is
 * always on, its timers fire, it holds a leader lock (one driver per route), and `/health` makes a
 * stopped schedule VISIBLE (`apiCron`). `/internal/alerts/run` is NOT here (in-process every minute; a
 * dead worker cannot report its own death). Cadence restarts with leadership (all three passes idempotent and self-bounding); `AlertSinkHealth` is a closed set and the body is never quoted. */
export interface ApiCronTarget {
  /** Closed name, stable across renames of the path — the key an operator greps for. */
  target: "sessions_reap" | "smtp_size" | "scheduled_send"
    | "send_reconcile" | "away_responder" | "platform_signals" | "unsubscribe_drain"
    | "account_lifecycle";
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
  /**
   * This target's 2xx body carries a `remaining` count, and the health row carries it forward.
   * Opt-in per target: the body is drained and dropped everywhere else, and a pass that has no
   * backlog to report would answer `null` for ever, which reads as a number nobody wrote.
   */
  readsRemaining?: true;
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
    // The pass makes at most `SEND_RECONCILE_BATCH` LOGIN ATTEMPTS per invocation, which is the
    // cost the 60-second ceiling is actually budgeted against; this bound is the caller's mirror
    // of that ceiling, not a hope. ATTEMPTS, not successes, and the distinction is what keeps
    // this comment true: a mailbox that is unreachable spends the connect timeout and throws, and
    // if those went uncharged a single broken mailbox could spend more than this whole ceiling
    // inside one invocation. It EXAMINES more rows than it dials — a mirror hit settles a
    // reservation with one indexed read and no connection — so the row count is not the number to
    // budget from.
    timeoutMs: 60 * 1000,
    // A tenth of the cadence — the sender's reason, one target over.
    jitterMs: 6 * 1000,
  },
  {
    // THE AWAY RESPONDER'S SENDER (mail 0087) — its being here at all is the fix. The pass used to run
    // INSIDE this worker on the cycle tail and could not work: this platform blocks outbound SMTP at the
    // port (`smtp-size.ts` measured twelve hosts, every dial a timeout, IMAP to the same host 300 ms), so
    // every reply threw, and each throw kept the at-most-once claim that silenced that correspondent. The
    // pass now lives in `@trafficflow/services` and runs on the API host, which can dial; this entry is the
    // clock that pokes it, like `scheduled_send` above (plus the shared reason: services may not enter this
    // app's runtime dependency set). EVERY MINUTE, matching the sender clock — "away" is about mail that
    // just arrived. The route bounds its own work (`AWAY_SENDS_PER_RUN`, one candidate page per account),
    // so an idle minute is one indexed read.
    target: "away_responder",
    route: "/internal/away/run",
    everyMs: 60 * 1000,
    // Its OWN first delay, deliberately not sharing `scheduled_send`'s 45 s: two targets that fire
    // together on every leader takeover would put two SMTP-dialling invocations on the same host at
    // the same instant, every deploy. Past the takeover window, and offset from the sender's.
    firstDelayMs: 52 * 1000,
    // The route claims only what one serverless invocation can deliver inside its own 60-second
    // ceiling; this bound is the caller's mirror of that ceiling, not a hope.
    timeoutMs: 60 * 1000,
    jitterMs: 6 * 1000,
  },
  {
    // WHAT THE PLATFORM SERVED (cloud 0030) — the API host's own 5xx rate, which it cannot measure about
    // itself: a 502-and-die invocation writes nothing to the database, so only the platform's request log
    // knows. This clock pokes the route that reads it; the route lives on the API host because the token
    // that can read the log is an env var on THAT deployment (polling here would provision the credential
    // onto a second host). EVERY FIVE MINUTES — the alert reads a fifteen-minute window, so three rows
    // mean one missed poll still leaves two windows; a coarser clock would make GAPS (one poll writes one
    // aligned window), and a gap is indistinguishable from a quiet period once summed. A deployment with no
    // platform token writes NOTHING and says so ("5xx: not measured"), distinguishable from a real zero.
    target: "platform_signals",
    route: "/internal/platform-signals/run",
    everyMs: 5 * 60 * 1000,
    // Late in the first cycle: it is an observability read with no customer waiting on it, and
    // its five-minute clock catches up within one cadence anyway. Distinct from `platform_costs`'
    // nine minutes so a leader takeover does not put two platform-API calls on the same instant.
    firstDelayMs: 3 * 60 * 1000,
    // The route walks a paged log endpoint under its own page budget, inside a platform ceiling
    // of 60 s; this is the caller's mirror of that ceiling, not a hope.
    timeoutMs: 60 * 1000,
    // A tenth of the cadence — {@link ApiCronTarget.jitterMs}'s rule. The default five minutes of
    // jitter on a five-minute clock would be a schedule made entirely of jitter, and the window
    // alignment that keeps re-polls idempotent would be doing all the work.
    jitterMs: 30 * 1000,
  },
  {
    // WHAT THE SCREENER'S OWN FAN-OUT COULD NOT FINISH. Capping the in-request fan-out is honest
    // only if something finishes the rest, and until this entry the drain was built, tested and
    // poked by nobody — the failure this table's census exists for. It runs on the API host for
    // the sibling reason above: the pass IS a service in `@trafficflow/services`.
    //
    // HOURLY, and the cadence is load-bearing: `UNSUB_DRAIN_WINDOW_MS` derives its look-back from
    // it, so a change here changes how far back a run reaches. An idle hour costs one indexed
    // read.
    target: "unsubscribe_drain",
    route: "/internal/unsubscribe/drain",
    everyMs: 60 * 60 * 1000,
    // Its own stagger, past the takeover window and distinct from every other target's, so a
    // leader takeover does not land this on the same instant as a dialling one.
    firstDelayMs: 9 * 60 * 1000,
    // THE SAME CONSTANT THE ROUTE BUDGETS AGAINST, imported rather than restated: this pair used
    // to be 60 s here and 45 s there, and nothing could see them disagree. The route's budget is
    // well under this; what this bound is for is the invocation that never answers at all.
    timeoutMs: UNSUB_DRAIN_CEILING_MS,
    // Its body says how many screened-out unsubscribes the window still holds. Carried onto the
    // health row: a flat `ok` cannot tell a pass that is keeping up from one falling behind.
    readsRemaining: true,
  },
  {
    // THE WALL'S NIGHTLY PASS (cloud 0040): the trial, closure and erasure-week notices, and the
    // erasure once its anchor plus a day of slack has passed. On the API host because the pass
    // sends customer mail through the transactional provider, which only that host holds. NIGHTLY
    // — every deadline it acts on is measured in days, and idempotency lives in the plane's own
    // anchors (the notices PK), so a missed poke costs a day of latency and never a double mail.
    target: "account_lifecycle",
    route: "/internal/account-lifecycle/run",
    everyMs: 24 * 60 * 60 * 1000,
    // Its own stagger, past the takeover window, distinct from every sibling's.
    firstDelayMs: 11 * 60 * 1000,
    // One plane read per live account at bounded concurrency plus a handful of mails: minutes
    // of headroom for a pass that is seconds at beta scale, mirroring the route's own patience.
    timeoutMs: 120 * 1000,
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
  /**
   * What the target's last SUCCESSFUL run said is still owed, for a target that reports one —
   * `null` on every other target and on one that has not answered yet. The two states are named
   * apart on purpose: `0` is "nothing left", `null` is "this pass does not say".
   */
  remaining: number | null;
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
  remaining: number | null;
  inFlight: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  controller: AbortController | null;
}

/**
 * The one field this side reads out of a pass's own answer, validated rather than believed, in
 * THREE states because there are three: a number the pass counted, an explicit `null` where the
 * pass says it did not measure, and `undefined` for a body this side cannot believe — not JSON,
 * not an object, no such field, or a value that is negative, fractional or not a number. Only the
 * last leaves the row's previous reading standing. Bounded by the same 32 KiB the rest of this
 * file assumes of our own routes: a body larger than that is not one of ours and is not parsed.
 */
export function readRemaining(body: string): number | null | undefined {
  if (body.length > 32 * 1024) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { return undefined; }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  if (!("remaining" in parsed)) return undefined;
  const n = (parsed as { remaining?: unknown }).remaining;
  // THE PASS SAYING "I DID NOT MEASURE" is not the same as a body this side cannot believe, and
  // the difference decides whether the row keeps its last reading. An explicit null is an answer:
  // the run did not reach the end of its window, and a stale small number left standing under it
  // would read as a healthy pass for as long as the pass stayed unable to look.
  if (n === null) return null;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 0) return undefined;
  return n;
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
      lastOkAt: null, lastAttemptAt: null, remaining: null,
      inFlight: false, timer: null, controller: null,
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
      // The body is DRAINED either way — keep-alive hygiene — and for every target but the one
      // that declares it, DROPPED: the API host logs its own passes and closed codes are all
      // this side keeps. The exception takes ONE number and validates it here rather than
      // trusting the shape: a body that is not JSON, or whose `remaining` is not a whole
      // non-negative number, leaves the row's previous answer alone rather than writing a lie.
      try {
        const text = await res.text();
        if (res.ok && t.readsRemaining === true) {
          const n = readRemaining(text);
          // `undefined` is the only value that leaves the row's previous answer standing: a body
          // this side cannot believe writes nothing. A number and an explicit null are both the
          // pass's own answer and both replace it.
          if (n !== undefined) state.remaining = n;
        }
      } catch { /* the status already answered */ }
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
          remaining: s.remaining,
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
