import { UNMETERED_STORAGE_CAP, type Logger } from "@trafficflow/core";
import {
  makeSendAdapter,
  ALERT_CRON_PATH, SESSIONS_REAP_CRON_PATH, SMTP_SIZE_CRON_PATH, SCHEDULED_SEND_CRON_PATH,
  SEND_RECONCILE_CRON_PATH, SENT_COPIES_CRON_PATH, UNSUB_DRAIN_CRON_PATH,
  type ApiDeps,
} from "@trafficflow/api";
import {
  runAwayResponderPass, runScheduledSendPass, runSendReconcilePass, runOwedSentCopyPass, SEND_RECONCILE_NET_TIMEOUTS,
  OWED_COPY_SELF_HOST, type AuthService,
} from "@trafficflow/services";
import { ALERT_PASS_EVERY_MS, ALERT_PASS_FIRST_DELAY_MS, ownAlertClock } from "./alert-clock.js";
import { API_CLOCK_LOCK_KEY, acquireLeaderLock, type LeaderLock } from "./clock-lock.js";
import { depsFor, type Runtime } from "./deps.js";

/**
 * THE CLOCKS INSIDE THE API PROGRAM.
 *
 * Two kinds. A self-hosted server keeps its own sending clock and its own alert clock, as it
 * always has: nothing outside the process pokes it ({@link startPlainChain}, `alert-clock.ts`).
 * And the passes a scheduler pokes over HTTP ({@link CLOCK_ROWS}) can run on this program's own
 * clock where the program is always on: `TF_API_CLOCKS=1`, OFF by default. A row is driven by
 * dispatching its route inside the process, with the same bearer, bounds and answers the outside
 * poke gets, and no socket.
 *
 * With the setting on, every clock of the program runs under ONE leader ({@link runUnderLeader}):
 * of two copies alive at once (a deploy), one drives and the other stands by.
 */

/** Which service a pass is for: a self-hosted server, the managed service, or both. */
export type ClockNeed = "plain" | "managed" | "both";

/**
 * Why a row is not driven from here yet, or null. `mail-dial`: the pass dials a mail provider, and
 * whether an always-on host can reach the providers has no reading yet. `follow-ups`: one fire of
 * the pass makes follow-up calls (a continuation, one erasure per account) this clock does not make.
 * Both stay with the scheduler that pokes them today.
 */
export type ClockHold = "mail-dial" | "follow-ups" | null;

export interface ClockRow {
  /** Closed name, the one the worker's schedule uses for the same pass. */
  target: string;
  route: string;
  everyMs: number;
  /** Delay after taking the lead before the first run: staggered, so the rows never land together. */
  firstDelayMs: number;
  /** Added per wait, never subtracted. */
  jitterMs: number;
  needs: ClockNeed;
  hold: ClockHold;
}

/** Up to this much is added to every wait unless a row says less: herd hygiene, never drift backwards. */
export const CLOCK_JITTER_MS = 5 * 60 * 1000;

/* Four routes whose constants the route package does not export: written out, and held to the
   route table by `test/clocks.test.ts` like every other row. */
const AWAY_RESPONDER_CRON_PATH = "/internal/away/run";
const ACCOUNT_LIFECYCLE_CRON_PATH = "/internal/account-lifecycle/run";
const SECURITY_NOTICES_CRON_PATH = "/internal/security-notices/run";
const STORAGE_MAILS_CRON_PATH = "/internal/storage-mails/run";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * The table: the worker's schedule of the API's internal passes, row for row (target, route,
 * cadence, first delay, jitter; `test/clocks.test.ts` holds the two equal and each route equal to
 * the route table's own constant). `needs` answers "does a self-hosted server need it": the session
 * reaper, the size probe and the unsubscribe drain do, and nothing ran them there; the lifecycle
 * mails and the storage mails belong to the managed service. The four sending passes and the
 * security notices are a self-hosted server's own chain ({@link startPlainChain}), so their rows
 * are the managed service's.
 */
export const CLOCK_ROWS: readonly ClockRow[] = [
  { target: "sessions_reap", route: SESSIONS_REAP_CRON_PATH, everyMs: DAY, firstDelayMs: 4 * MINUTE, jitterMs: CLOCK_JITTER_MS, needs: "both", hold: null },
  { target: "smtp_size", route: SMTP_SIZE_CRON_PATH, everyMs: DAY, firstDelayMs: 7 * MINUTE, jitterMs: CLOCK_JITTER_MS, needs: "both", hold: "mail-dial" },
  { target: "scheduled_send", route: SCHEDULED_SEND_CRON_PATH, everyMs: MINUTE, firstDelayMs: 45 * 1000, jitterMs: 6 * 1000, needs: "managed", hold: "mail-dial" },
  { target: "send_reconcile", route: SEND_RECONCILE_CRON_PATH, everyMs: MINUTE, firstDelayMs: 105 * 1000, jitterMs: 6 * 1000, needs: "managed", hold: "mail-dial" },
  { target: "away_responder", route: AWAY_RESPONDER_CRON_PATH, everyMs: MINUTE, firstDelayMs: 52 * 1000, jitterMs: 6 * 1000, needs: "managed", hold: "mail-dial" },
  { target: "unsubscribe_drain", route: UNSUB_DRAIN_CRON_PATH, everyMs: HOUR, firstDelayMs: 9 * MINUTE, jitterMs: CLOCK_JITTER_MS, needs: "both", hold: null },
  { target: "account_lifecycle", route: ACCOUNT_LIFECYCLE_CRON_PATH, everyMs: DAY, firstDelayMs: 11 * MINUTE, jitterMs: CLOCK_JITTER_MS, needs: "managed", hold: "follow-ups" },
  { target: "security_notices", route: SECURITY_NOTICES_CRON_PATH, everyMs: 5 * MINUTE, firstDelayMs: 6 * MINUTE, jitterMs: 30 * 1000, needs: "managed", hold: null },
  { target: "sent_copies", route: SENT_COPIES_CRON_PATH, everyMs: 5 * MINUTE, firstDelayMs: 2 * MINUTE, jitterMs: 30 * 1000, needs: "managed", hold: "mail-dial" },
  { target: "storage_mails", route: STORAGE_MAILS_CRON_PATH, everyMs: HOUR, firstDelayMs: 13 * MINUTE, jitterMs: CLOCK_JITTER_MS, needs: "managed", hold: null },
];

/** The managed service's alert pass, driven as a row: the pass runs on the staff door's role, behind its route. */
export const ALERT_ROW: ClockRow = {
  target: "alerts", route: ALERT_CRON_PATH, everyMs: ALERT_PASS_EVERY_MS, firstDelayMs: ALERT_PASS_FIRST_DELAY_MS,
  jitterMs: 0, needs: "managed", hold: null,
};

/** The rows this configuration drives itself, and the ones it leaves where they are. */
export function rowsFor(service: "plain" | "managed", rows: readonly ClockRow[] = [...CLOCK_ROWS, ALERT_ROW]): {
  driven: ClockRow[]; held: ClockRow[];
} {
  const mine = rows.filter((row) => row.needs === "both" || row.needs === service);
  return { driven: mine.filter((row) => row.hold === null), held: mine.filter((row) => row.hold !== null) };
}

/** One clock: a name, a cadence, and the pass. */
export interface DrivenClock {
  name: string;
  everyMs: number;
  firstDelayMs: number;
  jitterMs: number;
  run: () => Promise<unknown>;
}

export interface Stoppable {
  /** Arms nothing more, and resolves once a pass in flight has settled. */
  stop(): Promise<void>;
}

/**
 * Run each clock on its own chain: `setTimeout`, re-armed when the pass settles, never
 * `setInterval`, so a slow pass delays the next and never runs beside it. A pass that throws is
 * logged and the cadence continues.
 */
export function startChains(
  clocks: readonly DrivenClock[], log: Pick<Logger, "error">, random: () => number = Math.random,
): Stoppable {
  let stopped = false;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const inFlight = new Set<Promise<void>>();
  const arm = (clock: DrivenClock, delayMs: number): void => {
    if (stopped) return;
    const timer = setTimeout(() => {
      timers.delete(timer);
      const pass: Promise<void> = (async () => {
        try {
          await clock.run();
        } catch (err) {
          log.error("api_clock_pass_failed", { err, route: clock.name });
        }
      })().finally(() => {
        inFlight.delete(pass);
        arm(clock, clock.everyMs + Math.floor(random() * clock.jitterMs));
      });
      inFlight.add(pass);
    }, delayMs);
    timer.unref();
    timers.add(timer);
  };
  for (const clock of clocks) arm(clock, clock.firstDelayMs);
  return {
    async stop() {
      stopped = true;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      await Promise.all([...inFlight]);
    },
  };
}

/** How often a copy that does not lead asks again, and a leading one checks it still holds the lock. */
export const CLOCK_LEADER_RETRY_MS = 15_000;

export interface ClockHandle extends Stoppable {
  /** Whether this copy drives the clocks right now. */
  leading(): boolean;
}

/**
 * ONE DRIVER ACROSS COPIES. `start` runs only while this copy holds the session-level advisory
 * lock `key` on a dedicated connection to `url`; a copy that does not hold it stands by, arms
 * nothing, and asks again every `retryMs`. A lock that is lost (the session closed, another backend
 * holds it) stops the clocks at once and returns this copy to standby: a clock that keeps running
 * after its lock is gone is two drivers.
 */
export function runUnderLeader(opts: {
  url: string;
  key?: bigint;
  retryMs?: number;
  start: () => Stoppable;
  log: Pick<Logger, "info" | "warn" | "error">;
  acquire?: (url: string, key: bigint) => Promise<LeaderLock | null>;
}): ClockHandle {
  const key = opts.key ?? API_CLOCK_LOCK_KEY;
  const retryMs = opts.retryMs ?? CLOCK_LEADER_RETRY_MS;
  const acquire = opts.acquire ?? acquireLeaderLock;
  let stopped = false;
  let lock: LeaderLock | null = null;
  let running: Stoppable | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let turn: Promise<void> = Promise.resolve();

  const standDown = async (reason: string): Promise<void> => {
    const was = running;
    const held = lock;
    running = null;
    lock = null;
    if (was) {
      opts.log.warn("api_clocks_standby", { reason });
      await was.stop();
    }
    if (held) await held.release().catch(() => { /* the session is gone already */ });
  };

  const step = async (): Promise<void> => {
    if (stopped) return;
    if (lock) {
      // The heartbeat: is the lock still held by the backend that took it?
      const held = await lock.verify().catch(() => false);
      if (!held) await standDown("the clock lock is no longer held by this copy");
      return;
    }
    try {
      const taken = await acquire(opts.url, key);
      if (!taken) return;                       // another copy leads
      if (stopped) { await taken.release(); return; }
      lock = taken;
      running = opts.start();
      opts.log.info("api_clocks_leading", { state: "on" });
      void taken.lost.then(() => {
        if (lock === taken) turn = turn.then(() => standDown("the clock lock's session closed"));
      });
    } catch (err) {
      opts.log.error("api_clock_lock_failed", { err });
    }
  };

  const tick = (delayMs: number): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      turn = turn.then(step).finally(() => tick(retryMs));
    }, delayMs);
    timer.unref();
  };
  turn = step().finally(() => tick(retryMs));

  return {
    leading: () => running !== null,
    async stop() {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      await turn.catch(() => { /* logged where it happened */ });
      await standDown("stopping");
    },
  };
}

/** Drive one row: its route, dispatched inside the process with the internal bearer. */
export function driveRow(
  row: ClockRow, dispatch: (req: Request) => Promise<Response>, origin: string, secret: string,
  log: Pick<Logger, "warn">,
): DrivenClock {
  return {
    name: row.target,
    everyMs: row.everyMs,
    firstDelayMs: row.firstDelayMs,
    jitterMs: row.jitterMs,
    run: async () => {
      const res = await dispatch(new Request(`${origin}${row.route}`, { headers: { authorization: `Bearer ${secret}` } }));
      // The body is drained and dropped: a route's answer is its own log line.
      await res.arrayBuffer().catch(() => { /* nothing to read */ });
      if (!res.ok) log.warn("api_clock_pass_refused", { route: row.route, status: res.status });
    },
  };
}

/**
 * SEND LATER's clock on a self-hosted server (mail 0077) — a minute, the hosted deployment's own
 * cadence and for its reason: the appointment's stated precision is "±about a minute". The first
 * pass runs shortly after listen so an appointment that came due during a restart is not a minute
 * later than it already is.
 */
export const SCHEDULED_SEND_EVERY_MS = 60_000;
export const SCHEDULED_SEND_FIRST_DELAY_MS = 15_000;

/**
 * ── SEND LATER'S CLOCK RUNS IN THIS PROCESS, AND THAT IS THE DECISION ──────────────────────
 *
 * The hosted deployment drives `runScheduledSendPass` over HTTP because its API host is
 * serverless — something external must supply the clock. THIS host is the opposite case: one
 * always-on process that already holds the database, the key provider and the OAuth token
 * provider, so the pass runs in-process on a settle-then-re-arm chain (never `setInterval`;
 * a slow pass must not overlap itself). Without this, the schedule verbs would accept
 * appointments no clock ever keeps on a box whose operator armed no internal cron — mail
 * "scheduled" forever, which is the feature promising and never delivering. The internal
 * HTTP route stays mounted for an operator who prefers an external scheduler; overlap
 * between the two is safe by the claim's own `FOR UPDATE SKIP LOCKED`.
 *
 * There is no eligibility gate: this box meters nothing, so every account is eligible and
 * every due appointment is kept. The storage cap is this host's typed UNMETERED —
 * the same declaration its send route makes for the sent-copy projection.
 */
export function startPlainChain(runtime: Runtime): Stoppable {
  // The names the chain below was written with, bound to the one wiring's runtime.
  const { logger } = runtime;
  const cfg = { origin: runtime.cfg.origin.appOrigin ?? "http://localhost" };
  const owned = { db: runtime.db.request() };
  const rt = runtime;
  const buildDeps = (req: Request, of: Runtime): ApiDeps => depsFor(req, of);
  let sendClock: ReturnType<typeof setTimeout> | null = null;
  let sendClockStopped = false;
  /**
   * The pass IN FLIGHT, or null — held so shutdown can AWAIT it before the pool closes. A
   * cleared timer only prevents the next tick; a send already mid-SMTP still needs the
   * database to finalize its reservation, and a pool closed under it records a delivered
   * message as `pending` until the recovery arm resolves it a poll-eternity later.
   */
  let sendPassInFlight: Promise<void> | null = null;
  /**
   * The reconciling half of the send clock — stranded `pending` reservations, resolved by the
   * same verify-by-Sent the client's own retry runs. Its own function because it runs on BOTH
   * arms of the tick below (after a good sender pass, and after a failed one), and its own
   * `try` because a claim that fails here must not look like the sender's.
   */
  const reconcileStrandedSends = async (): Promise<void> => {
    try {
      const passDeps = buildDeps(new Request(cfg.origin), rt);
      const r = await runSendReconcilePass(owned.db, {
        // THE SAME DEADLINES THE HOSTED DOOR THREADS, and this caller was missed when they were
        // introduced — leaving the only other production runner of this pass with no dial bound
        // at all. It matters differently here: nothing kills this process, so one mailbox whose
        // LIST trickles parks the awaited pass and stalls the whole send clock behind it.
        openSendAdapter: (mailboxId) =>
          makeSendAdapter(passDeps, mailboxId, { timeouts: SEND_RECONCILE_NET_TIMEOUTS }),
        log: logger,
      });
      if (r.claimed > 0) {
        logger.info("send_reconcile_pass", {
          claimed: r.claimed, sent: r.sent, unverified: r.unverified,
          deferred: r.deferred, resolvedElsewhere: r.resolvedElsewhere, gaveUp: r.gaveUp,
        });
      }
    } catch (err) {
      logger.error("send_reconcile_pass_failed", { err });
    }
  };
  /**
   * The owed Sent copies (`OWED_COPY_SELF_HOST`): a delivered letter whose copy a restart or an
   * IMAP outage kept out of Sent is filed here, after the reconciler, on both arms. Its own `try`.
   */
  const fileOwedSentCopies = async (): Promise<void> => {
    try {
      const passDeps = buildDeps(new Request(cfg.origin), rt);
      const r = await runOwedSentCopyPass(owned.db, {
        openSendAdapter: (mailboxId) =>
          makeSendAdapter(passDeps, mailboxId, { timeouts: SEND_RECONCILE_NET_TIMEOUTS }),
        resolveStorageCap: async () => UNMETERED_STORAGE_CAP,
        log: logger,
      });
      if (r.claimed + r.dropped > 0) logger.info("send_sent_copy_pass", { ...r });
    } catch (err) {
      logger.error("send_sent_copy_pass_failed", { err });
    }
  };
  const armSendClock = (delayMs: number): void => {
    if (sendClockStopped) return;
    sendClock = setTimeout(() => {
      sendPassInFlight = (async () => {
        try {
          const passDeps = buildDeps(new Request(cfg.origin), rt);
          const kept = rt.services.scheduledFiles;
          const r = await runScheduledSendPass(owned.db, {
            openSendAdapter: (mailboxId) => makeSendAdapter(passDeps, mailboxId),
            resolveStorageCap: async () => UNMETERED_STORAGE_CAP,
            keepOwedCopy: OWED_COPY_SELF_HOST,
            // This server's sealed files (mail 0180): opened for the send, tidied before the claim.
            ...(kept?.atRest === "sealed" ? { files: { open: kept.sealer.open.bind(kept.sealer), tidy: true } } : {}),
            log: logger,
          });
          if (r.claimed > 0) {
            logger.info("scheduled_send_pass", {
              claimed: r.claimed, sent: r.sent, unverified: r.unverified,
              failed: r.failed, deferred: r.deferred,
            });
          }
          /**
           * AND THEN THE RECONCILER, on the same tick and AFTER the sender.
           *
           * After, because the sender is the only thing on this box that CREATES a stranded
           * reservation, and a reconciler that ran first would spend the cycle examining rows
           * whose fate the sender is about to decide. It is one clock rather than two for the
           * same reason the hosted deployment splits them into two: there, both are serverless
           * invocations racing a platform kill and sharing one is a budget error; here nothing
           * kills the process, so a second timer would buy only a second thing to shut down.
           *
           * No `resolveStorageCap` and no `surfaceMaxTotalBytes`: this pass never sends, so it
           * never projects a sent copy and never assembles a body.
           */
          await reconcileStrandedSends();
          await fileOwedSentCopies();

          /**
           * THE AWAY RESPONDER, ON THE SAME TICK (mail 0087) — one always-on process, one clock.
           *
           * On this host the two passes share a tick rather than each arming their own, which is
           * the opposite of the hosted deployment's shape and right for the opposite reason: there,
           * two serverless invocations each get their own 60-second ceiling and must not share one;
           * here there is no ceiling and no invocation, so a second timer would only add a second
           * thing that can drift, fail to be cleared on shutdown, and overlap itself.
           *
           * AFTER the scheduled sender, deliberately: an appointment has a stated time and an away
           * reply does not, so if one pass is going to be delayed by the other it should be this
           * one. Its own try/catch, so a responder fault never costs the appointment clock its
           * cadence — the containment rule every pass on every host here follows.
           *
           * `accountEligible` is the suspension gate, on the handle this host runs on; there is no
           * mailbox filter, because a self-host serves its own account's mailboxes and the pass's
           * organizer JOIN is what keeps it off a mailbox this install merely reads.
           */
          try {
            const a = await runAwayResponderPass(owned.db, {
              openSendAdapter: (mailboxId) => makeSendAdapter(buildDeps(new Request(cfg.origin), rt), mailboxId),
              log: logger,
            });
            if (a.examined > 0) {
              logger.info("away_responder_pass", {
                accounts: a.accounts, examined: a.examined, sent: a.sent,
                unverified: a.unverified, throttled: a.throttled, suppressed: a.suppressed,
                deferredAccounts: a.deferredAccounts, deferredCandidates: a.deferredCandidates,
                capped: a.capped, refusedErased: a.refusedErased,
                refusedNotOrganizer: a.refusedNotOrganizer,
              });
            }
          } catch (err) {
            logger.error("away_responder_pass_failed", { err });
          }

          // THE SIGN-IN THROTTLE'S SECURITY NOTICES, on the same tick and never from a request (the
          // hosted door, `SECURITY_NOTICES_CRON_PATH`, says why). Its own try/catch, the containment rule.
          try {
            const auth = rt.services.auth as unknown as { drainSecurityNotices?: AuthService["drainSecurityNotices"] };
            const n = await auth.drainSecurityNotices?.({
              db: owned.db, accountId: "", userId: null, now: () => new Date(), requestId: "",
            });
            if (n && n.sent + n.failed + n.dropped > 0) logger.info("security_notices_drained", { ...n });
          } catch (err) {
            logger.error("security_notices_failed", { err });
          }
        } catch (err) {
          // The pass absorbs per-row faults itself; this catches the claim. The appointments
          // stand and the next minute asks again — one bad pass never kills the cadence.
          logger.error("scheduled_send_pass_failed", { err });
          // …AND THE RECONCILER STILL RUNS. Its own claim is independent of the sender's, so a
          // sender whose claim is failing must not also stop stranded reservations being
          // resolved — that pairing would take out both halves of the send path's recovery at
          // once, and the second half is the one nothing else can do.
          await reconcileStrandedSends();
          await fileOwedSentCopies();
        } finally {
          sendPassInFlight = null;
          armSendClock(SCHEDULED_SEND_EVERY_MS);
        }
      })();
    }, delayMs);
    sendClock.unref();
  };
  armSendClock(SCHEDULED_SEND_FIRST_DELAY_MS);
  return {
    async stop() {
      // A pass that has not started must not start over a closing pool. One already in flight
      // finishes: a send mid-flight must finalize its reservation BEFORE the database goes.
      sendClockStopped = true;
      if (sendClock !== null) clearTimeout(sendClock);
      if (sendPassInFlight) await sendPassInFlight.catch(() => { /* its own catch logged */ });
    },
  };
}

/**
 * Start this program's clocks, or null where it keeps none (a function, and a managed service
 * whose passes a scheduler pokes).
 *
 * `TF_API_CLOCKS` off: a self-hosted server's own chain and alert clock, armed as they always
 * were. On: those and the rows this configuration drives, all under one leader. The rows that stay
 * with their scheduler are named once at start.
 */
export function startClocks(
  runtime: Runtime, dispatch: (req: Request) => Promise<Response>,
  seams: { rows?: readonly ClockRow[]; retryMs?: number; lockKey?: bigint } = {},
): ClockHandle | null {
  const { cfg, logger } = runtime;
  if (cfg.door === "function") return null;
  const own = cfg.chosen.sendClock === "own-chain";
  const startOwn = (): Stoppable[] => {
    if (!own) return [];
    const alert = ownAlertClock(runtime);
    return [startPlainChain(runtime), ...(alert ? [alert] : [])];
  };
  const all = (parts: Stoppable[]): Stoppable => ({ stop: async () => { await Promise.all(parts.map((p) => p.stop())); } });

  if (!cfg.clocks.inProcess) {
    if (!own) return null;
    const running = all(startOwn());
    return { leading: () => true, stop: () => running.stop() };
  }
  // The settings refused the start without these two.
  const secret = cfg.alerts!.secret;
  const listenUrl = cfg.database.listenUrl!;
  const { driven, held } = rowsFor(own ? "plain" : "managed", seams.rows);
  logger.info("api_clocks_configured", {
    state: "on", count: driven.length, detail: driven.map((row) => row.target).join(","),
    reason: held.length > 0 ? `left with their scheduler: ${held.map((row) => row.target).join(",")}` : "none held",
  });
  const origin = cfg.origin.appOrigin ?? "http://localhost";
  return runUnderLeader({
    url: listenUrl,
    ...(seams.lockKey !== undefined ? { key: seams.lockKey } : {}),
    ...(seams.retryMs !== undefined ? { retryMs: seams.retryMs } : {}),
    log: logger,
    start: () => all([
      ...startOwn(),
      startChains(driven.map((row) => driveRow(row, dispatch, origin, secret, logger)), logger),
    ]),
  });
}
