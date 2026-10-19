import { runApiAlertPass } from "@trafficflow/api";
import type { Logger } from "@trafficflow/core";
import { buildDeps, type ServerRuntime } from "./deps.js";

/**
 * THE API ALERT ARM'S CLOCK on this host. The managed host's routes are called by schedulers
 * outside it; here nothing outside the process calls them, and the API pass is the only observer
 * of `worker_down` (the organizer cannot report its own death) — so without this clock a dead
 * organizer pages nobody. The send clock's shape: `setTimeout`, re-armed when the pass settles,
 * never `setInterval`, so a slow pass delays the next and never runs beside it. Its own chain and
 * not a step on the send tick: the pager must not inherit the latency of what it watches. The
 * routes stay mounted for an external scheduler; an overlap is bounded by the claim lease.
 */

/** The worker's `DEFAULT_ALERT_INTERVAL_MS`: `leaderStaleMs` is two minutes, so `worker_down` pages within three. */
export const ALERT_PASS_EVERY_MS = 60_000;
/** The first pass after boot; the send clock's first tick is at 15 s. */
export const ALERT_PASS_FIRST_DELAY_MS = 30_000;

export interface AlertClock {
  /** Arms nothing more, and resolves once a pass in flight has settled — before the pool closes. */
  stop(): Promise<void>;
}

export function startAlertClock(opts: {
  run: () => Promise<unknown>;
  everyMs: number;
  firstDelayMs: number;
  log: Pick<Logger, "error">;
}): AlertClock {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let inFlight: Promise<void> | null = null;
  const tick = async (): Promise<void> => {
    try {
      await opts.run();
    } catch (err) {
      // The pass answers its own faults; this is what escaped it. The next minute asks again.
      opts.log.error("alert_pass_failed", { err });
    }
  };
  const arm = (delayMs: number): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      timer = null;
      const pass: Promise<void> = tick().finally(() => {
        if (inFlight === pass) inFlight = null;
        arm(opts.everyMs);
      });
      inFlight = pass;
    }, delayMs);
    timer.unref();
  };
  arm(opts.firstDelayMs);
  return {
    async stop() {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      if (inFlight) await inFlight;
    },
  };
}

/**
 * The clock this process runs, or null: armed by `TF_ALERT_SECRET` alone, as the routes are. One
 * boot line either way, naming the cadence and the arms — an armed clock with no arm writes
 * `alert_state` and pages nobody, and this line plus `/health`'s `alertSinks` are where that shows.
 * The pass runs on per-tick deps, the send clock's pattern, so it reads the composition the routes do.
 */
export function alertClockFor(
  rt: ServerRuntime,
  timing: { everyMs?: number; firstDelayMs?: number } = {},
): AlertClock | null {
  const { cfg, logger } = rt;
  // This server reaches no entitlements program, so no billing plane is read: said once at boot.
  logger.info("plane_ops_watch", { state: "off", reason: "this server reaches no billing plane" });
  if (!cfg.alerts) {
    logger.info("alert_clock_unarmed", { configVar: "TF_ALERT_SECRET" });
    return null;
  }
  const everyMs = timing.everyMs ?? ALERT_PASS_EVERY_MS;
  const names = rt.alertSinks.map((s) => s.name);
  logger.info("alert_clock_armed", { everyMs, alertSinks: names });
  if (names.length === 1) {
    // The worker's line: one arm delivers every page right up to its vendor's outage, then nothing.
    logger.warn("alert_sinks_single_vendor", {
      alertSinks: names,
      reason: "the pager has exactly one delivery arm; a single vendor outage silences it entirely — " +
        "arm a second: TF_ALERT_WEBHOOK_URL, TF_ALERT_TELEGRAM_BOT_TOKEN + TF_ALERT_TELEGRAM_CHAT_ID, " +
        "or TF_ALERT_EMAIL (with SMTP_URL + MAIL_FROM)",
    });
  }
  const log = logger.child({ route: "alert_clock" });
  return startAlertClock({
    run: async () => {
      const alerts = buildDeps(new Request(cfg.origin), rt).alerts;
      if (!alerts?.db) throw new Error("the alert pass has no handle on this host");
      await runApiAlertPass(alerts, log, () => new Date(), alerts.db);
    },
    everyMs,
    firstDelayMs: timing.firstDelayMs ?? ALERT_PASS_FIRST_DELAY_MS,
    log: logger,
  });
}
